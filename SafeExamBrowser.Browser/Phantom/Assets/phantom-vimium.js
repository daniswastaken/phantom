/*
 * Phantom Vimium Content Engine
 * Ported & bundled from https://github.com/philc/vimium (v2.4.2)
 * Scoped inside an idempotent IIFE — never pollutes window.chrome or page globals.
 */
(function () {
  "use strict";

  if (window.__phantomVimium) {
    return;
  }

  let isVimiumActive = false;
  let clipboardPolicy = "Isolated";
  let initialized = false;
  let normalMode = null;
  let frameId = 0;
  let lastFocusedInputEl = null;

  const forTrusted = function (handler) {
    return function (event) {
      if (event && event.isTrusted) {
        return handler.apply(this, arguments);
      }
      return true;
    };
  };

  // Fallback polyfill for Vomnibar stub in case a command references it
  const Vomnibar = {
    activate() {},
    activateInNewTab() {},
    activateTabSelection() {},
    activateBookmarks() {},
    activateBookmarksInNewTab() {},
    activateCommandSelection() {},
    activateEditUrl() {},
    activateEditUrlInNewTab() {}
  };

  // =========================================================================
  // Scoped Chrome Extension API Shim (strictly local — never touches window.chrome)
  // =========================================================================
  const localMarks = Object.create(null);

  function createStorageArea(initialData, areaName) {
    const store = Object.assign(Object.create(null), initialData || {});
    return {
      get(keys, callback) {
        let result = {};
        if (keys == null) {
          result = Object.assign({}, store);
        } else if (typeof keys === "string") {
          if (Object.prototype.hasOwnProperty.call(store, keys)) {
            result[keys] = store[keys];
          }
        } else if (Array.isArray(keys)) {
          for (const k of keys) {
            if (Object.prototype.hasOwnProperty.call(store, k)) {
              result[k] = store[k];
            }
          }
        } else if (typeof keys === "object") {
          for (const [k, defVal] of Object.entries(keys)) {
            result[k] = Object.prototype.hasOwnProperty.call(store, k) ? store[k] : defVal;
          }
        }
        if (typeof callback === "function") {
          callback(result);
        }
        return Promise.resolve(result);
      },
      set(items, callback) {
        const changes = {};
        for (const [k, v] of Object.entries(items || {})) {
          changes[k] = { oldValue: store[k], newValue: v };
          store[k] = v;
        }
        storageChangeListeners.forEach((fn) => {
          try { fn(changes, areaName || "session"); } catch (_err) {}
        });
        if (typeof callback === "function") {
          callback();
        }
        return Promise.resolve();
      },
      remove(keys, callback) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) {
          delete store[k];
        }
        if (typeof callback === "function") {
          callback();
        }
        return Promise.resolve();
      },
      clear(callback) {
        for (const k of Object.keys(store)) {
          delete store[k];
        }
        if (typeof callback === "function") {
          callback();
        }
        return Promise.resolve();
      },
      setAccessLevel() {}
    };
  }

  const storageChangeListeners = [];
  const runtimeMessageListeners = [];

  function postBrowserAction(action, extra) {
    try {
      if (window.CefSharp && typeof window.CefSharp.PostMessage === "function") {
        window.CefSharp.PostMessage(Object.assign({
          Type: "Phantom",
          Service: "browserAction",
          Action: action
        }, extra || {}));
        return true;
      }
    } catch (_err) {}
    return false;
  }

  function dispatchLocalMessage(message) {
    if (message && message.handler === "runInTopFrame" && message.registryEntry) {
      const fn = NormalModeCommands[message.registryEntry.command];
      if (typeof fn === "function") {
        return fn(message.sourceFrameId || 0, message.registryEntry);
      }
    }
    const results = [];
    for (const listener of runtimeMessageListeners.slice()) {
      try {
        listener(message, { frameId: 0 }, function (res) { results.push(res); });
      } catch (_err) {}
    }
    return results[0];
  }

  const syncStorageArea = createStorageArea({
    settingsVersion: "2.4.2",
    grabBackFocus: true,
    linkHintCharacters: "sadfjklewcmpgh",
    scrollStepSize: 60,
    smoothScroll: true,
    filterLinkHints: false,
    exclusionRules: []
  }, "sync");
  const localStorageArea = createStorageArea({}, "local");
  const sessionStorageArea = createStorageArea({}, "session");

  const chrome = {
    extension: {
      inIncognitoContext: false
    },
    storage: {
      sync: syncStorageArea,
      local: localStorageArea,
      session: sessionStorageArea,
      onChanged: {
        addListener(fn) { storageChangeListeners.push(fn); },
        removeListener(fn) {
          const idx = storageChangeListeners.indexOf(fn);
          if (idx >= 0) storageChangeListeners.splice(idx, 1);
        }
      }
    },
    runtime: {
      id: "phantom-vimium",
      lastError: null,
      getManifest() {
        return { version: "2.4.2", name: "Phantom Vimium" };
      },
      getURL(resourcePath) {
        return resourcePath;
      },
      onMessage: {
        addListener(fn) { runtimeMessageListeners.push(fn); },
        removeListener(fn) {
          const idx = runtimeMessageListeners.indexOf(fn);
          if (idx >= 0) runtimeMessageListeners.splice(idx, 1);
        }
      },
      sendMessage(request, callback) {
        let response = {};
        const handler = request && request.handler;
        switch (handler) {
          case "initializeFrame":
            response = {
              isEnabledForUrl: isVimiumActive,
              passKeys: "",
              isFirefox: false,
              firefoxVersion: null,
              frameId: 0
            };
            break;
          case "getBrowserInfo":
            response = { isFirefox: false, firefoxVersion: null };
            break;
          case "domReady":
            response = {};
            break;
          case "getCurrentTabUrl":
            response = window.location.href;
            break;
          case "prepareToActivateLinkHintsMode": {
            const modeIndex = request.modeIndex;
            const requestedByHelpDialog = request.requestedByHelpDialog;
            Promise.resolve().then(() => {
              if (!isVimiumActive) {
                return;
              }
              const descriptors = HintCoordinator.getHintDescriptors({
                modeIndex: modeIndex,
                requestedByHelpDialog: requestedByHelpDialog
              });
              HintCoordinator.activateMode({
                frameId: 0,
                originatingFrameId: 0,
                frameIdToHintDescriptors: { 0: descriptors },
                modeIndex: modeIndex
              });
            });
            response = {};
            break;
          }
          case "broadcastLinkHintsMessage":
            if (request.messageType && typeof HintCoordinator[request.messageType] === "function") {
              HintCoordinator[request.messageType](request);
            }
            response = {};
            break;
          case "sendMessageToFrames":
            if (request.message) {
              dispatchLocalMessage(request.message);
            }
            response = {};
            break;
          case "openUrlInNewTab":
          case "openUrlInNewWindow":
            postBrowserAction("openUrlInNewWindow", { Url: request.url });
            break;
          case "openUrlInCurrentTab":
            postBrowserAction("openUrlInCurrentWindow", { Url: request.url });
            break;
          case "createMark":
            localMarks[request.markName] = { scrollX: request.scrollX || 0, scrollY: request.scrollY || 0 };
            break;
          case "gotoMark": {
            const pos = localMarks[request.markName];
            if (pos) {
              window.scrollTo(pos.scrollX, pos.scrollY);
            }
            break;
          }
          case "runBackgroundCommand": {
            const cmd = request.registryEntry && request.registryEntry.command;
            const count = request.count || 1;
            switch (cmd) {
              case "reload":
                if (!postBrowserAction("reload", { Count: count })) {
                  window.location.reload();
                }
                break;
              case "goBack":
                if (!postBrowserAction("back", { Count: count })) {
                  window.history.go(-count);
                }
                break;
              case "goForward":
                if (!postBrowserAction("forward", { Count: count })) {
                  window.history.go(count);
                }
                break;
              case "nextTab":
                postBrowserAction("nextWindow", { Count: count });
                break;
              case "previousTab":
                postBrowserAction("prevWindow", { Count: count });
                break;
              case "firstTab":
                postBrowserAction("firstWindow", { Count: count });
                break;
              case "lastTab":
                postBrowserAction("lastWindow", { Count: count });
                break;
              case "removeTab":
                postBrowserAction("closeSecondaryWindow", { Count: count });
                break;
              case "nextFrame":
                postBrowserAction("nextFrame", { Count: count });
                break;
            }
            break;
          }
        }
        if (typeof callback === "function") {
          callback(response);
        }
        return Promise.resolve(response);
      }
    }
  };

  // =========================================================================
  // Isolated Shadow DOM UI Container (Hint markers, HUD, Find bar, Help overlay)
  // =========================================================================
  const VIMIUM_CSS = "/*\n * Many CSS class names in this file use the verbose \"vimium-\" as the class name. This is so we\n * don't use the same CSS class names that the page is using, so the page's CSS doesn't mess with\n * the style of our Vimium dialogs.\n *\n * We use the maximum z-index value for all Vimium elements to guarantee that they always appear on\n * top. Chrome supports z-index values up to 2,147,483,647 (= 2^31 - 1). We utilize the maximum\n * z-index value allowable to ensure Vimium elements have precedence over all other page elements.\n */\n\n/*\n * This vimium-reset class can be added to any of our UI elements to give it a clean slate. This is\n * useful in case the page has declared a broad rule like \"a { padding: 50px; }\" which will mess up\n * our UI. These declarations contain more specifiers than necessary to increase their specificity\n * (precedence).\n */\n\n:root {\n  --vimium-background-color: white;\n  --vimium-background-text-color: black;\n  --vimium-foreground-color: white;\n  --vimium-foreground-text-color: black;\n  --vimium-link-color: blue;\n}\n\n.vimium-reset,\ndiv.vimium-reset,\nspan.vimium-reset,\ntable.vimium-reset,\na.vimium-reset,\na:visited.vimium-reset,\na:link.vimium-reset,\na:hover.vimium-reset,\ntd.vimium-reset,\ntr.vimium-reset {\n  background: none;\n  border: none;\n  bottom: auto;\n  box-shadow: none;\n  color: black;\n  cursor: auto;\n  display: inline;\n  float: none;\n  font-family: \"Helvetica Neue\", \"Helvetica\", \"Arial\", sans-serif;\n  font-size: inherit;\n  font-style: normal;\n  font-variant: normal;\n  font-weight: normal;\n  height: auto;\n  left: auto;\n  letter-spacing: 0;\n  line-height: 100%;\n  margin: 0;\n  max-height: none;\n  max-width: none;\n  min-height: 0;\n  min-width: 0;\n  opacity: 1;\n  padding: 0;\n  position: static;\n  right: auto;\n  text-align: left;\n  text-decoration: none;\n  text-indent: 0;\n  text-shadow: none;\n  text-transform: none;\n  top: auto;\n  vertical-align: baseline;\n  white-space: normal;\n  width: auto;\n  z-index: 2147483647;\n}\n\nthead.vimium-reset,\ntbody.vimium-reset {\n  display: table-header-group;\n}\n\ntbody.vimium-reset {\n  display: table-row-group;\n}\n\n/*\n * Linkhints CSS\n */\n\n/* Prior to 2025, we used camel case for all CSS selectors. We're preserving some camel case class\n * names here in link hints for backwards compatibility, because they're user-customizable via the\n * userDefinedLinkHintCss setting.\n *\n * Our default example value for userDefinedLinkHintCss refers to the \"vimiumHintMarker\" and\n * \"matchingCharacter\" classes. We'll assume these are user-facing and should not be changed:\n *   - vimiumHintMarker\n *   - matchingCharacter\n *   - vimiumActiveHintMarker\n *\n * Note that link hint elements have both internal-vimium-hint-marker and vimiumHintMarker classes.\n * Presumably the \"internal-\" classes were meant to contain non-user-facing styles, and\n * vimiumHintMarker was meant to be an empty vessel for users to attach their own styles to.\n */\n\ndiv#vimium-hint-marker-container {\n  pointer-events: none;\n}\n\ndiv.internal-vimium-hint-marker {\n  position: absolute;\n  display: block;\n  top: -1px;\n  left: -1px;\n  white-space: nowrap;\n  overflow: hidden;\n  font-size: 11px;\n  padding: 1px 3px 0px 3px;\n  background: linear-gradient(to bottom, #fff785 0%, #ffc542 100%);\n  border: solid 1px #c38a22;\n  border-radius: 3px;\n  box-shadow: 0px 3px 7px 0px rgba(0, 0, 0, 0.3);\n  z-index: 2147483647;\n}\n\ndiv.internal-vimium-hint-marker span {\n  color: #302505;\n  font-family: Helvetica, Arial, sans-serif;\n  font-weight: bold;\n  font-size: 11px;\n  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.6);\n}\n\ndiv.internal-vimium-hint-marker > .matchingCharacter {\n  color: #d4ac3a;\n}\n\ndiv > .vimiumActiveHintMarker span {\n  color: #a07555 !important;\n}\n\n/* Input hints CSS */\n\ndiv.internal-vimium-input-hint {\n  position: absolute;\n  display: block;\n  background-color: rgba(255, 247, 133, 0.3);\n  border: solid 1px #c38a22;\n  pointer-events: none;\n}\n\ndiv.internal-vimium-selected-input-hint {\n  background-color: rgba(255, 102, 102, 0.3);\n  border: solid 1px #993333 !important;\n}\n\ndiv.internal-vimium-selected-input-hint span {\n  color: white !important;\n}\n\ndiv.vimium-highlighted-frame {\n  position: fixed;\n  top: 0px;\n  left: 0px;\n  width: 100%;\n  height: 100%;\n  padding: 0px;\n  margin: 0px;\n  border: 5px solid yellow;\n  box-sizing: border-box;\n  pointer-events: none;\n}\n\niframe.vimium-help-dialog-frame {\n  background-color: rgba(10, 10, 10, 0.6);\n  padding: 0px;\n  top: 0px;\n  left: 0px;\n  width: 100%;\n  height: 100%;\n  display: block;\n  position: fixed;\n  border: none;\n  z-index: 2147483647;\n}\n\niframe.vimium-hud-frame {\n  background-color: transparent;\n  padding: 0px;\n  overflow: hidden;\n  display: block;\n  position: fixed;\n  width: 20%;\n  min-width: 350px;\n  height: 58px;\n  bottom: -14px;\n  right: 20px;\n  margin: 0 0 0 -40%;\n  border: none;\n  z-index: 2147483647;\n  opacity: 0;\n}\n\nbody.vimium-find-mode ::selection {\n  background: #ff9632;\n}\n\niframe.vomnibar-frame {\n  background-color: transparent;\n  padding: 0px;\n  overflow: hidden;\n\n  display: block;\n  position: fixed;\n  width: calc(80% + 20px); /* same adjustment as in pages/vomnibar_page.js */\n  min-width: 400px;\n  height: calc(100% - 70px);\n  top: 70px;\n  left: 50%;\n  /* TODO(philc): Why are we doing this negative margin, rather than just using right: 20% ? */\n  margin: 0 0 0 -40%;\n  border: none;\n  font-family: sans-serif;\n  z-index: 2147483647;\n}\n\ndiv.vimium-flash {\n  /* Let clicks and elementFromPoint pass through to element under the flash. */\n  pointer-events: none;\n  box-shadow: 0px 0px 4px 2px #4183c4;\n  padding: 1px;\n  background-color: transparent;\n  position: absolute;\n  z-index: 2147483647;\n}\n\n/* UIComponent CSS */\niframe.vimium-ui-component-hidden {\n  display: none;\n}\n\niframe.vimium-ui-component-visible {\n  display: block;\n  color-scheme: light dark;\n}\n\niframe.vimium-non-clickable {\n  pointer-events: none;\n}\n\n@media (prefers-color-scheme: dark) {\n  :root {\n    --vimium-background-color: #1d1d1f;\n    --vimium-background-text-color: #e3e3e3;\n    --vimium-foreground-color: #292a2d;\n    --vimium-foreground-text-color: #e8eaed;\n    --vimium-link-color: #8ab4f8;\n  }\n\n  /* DarkReader is a popular dark mode browser extension. It can apply an invert filter to the whole\n   * page to make the page dark, when used in Filter and Filter+ modes. We want to reverse/invert\n   * that filter again for Vimium's UI elements, because Vimium is already dark mode aware. */\n  iframe.vimium-reverse-dark-reader-filter {\n    -webkit-filter: invert(100%) hue-rotate(180deg) !important;\n    filter: invert(100%) hue-rotate(180deg) !important;\n  }\n\n  /* Dark mode CSS for options page and exclusions */\n\n  body.vimium-body {\n    background-color: var(--vimium-background-color);\n    color: var(--vimium-background-text-color);\n  }\n\n  body.vimium-body a,\n  body.vimium-body a:visited {\n    color: var(--vimium-link-color);\n  }\n\n  body.vimium-body textarea,\n  body.vimium-body input {\n    background-color: var(--vimium-foreground-color);\n    border-color: var(--vimium-foreground-color);\n    color: var(--vimium-foreground-text-color);\n  }\n\n  body.vimium-body div.example {\n    color: #8a9096;\n  }\n}\n\n#hud-container {\n  display: block;\n  position: fixed;\n  width: calc(100% - 20px);\n  bottom: 8px;\n  left: 8px;\n  background-color: var(--vimium-foreground-color);\n  color: var(--vimium-foreground-text-color);\n  text-align: left;\n  border-radius: 4px;\n  box-shadow: 0px 2px 10px rgba(0, 0, 0, 0.8);\n  border: 1px solid #aaa;\n  z-index: 2147483647;\n  font-family: \"Helvetica Neue\", Helvetica, Arial, sans-serif;\n}\n\n#search-area {\n  display: block;\n  padding: 3px;\n  color: var(--vimium-foreground-text-color);\n  border-radius: 4px 4px 0 0;\n}\n\n#hud {\n  font-size: 14px;\n  height: 30px;\n  margin-bottom: 0;\n  padding: 2px 4px;\n  border-radius: 3px;\n  width: 100%;\n  outline: none;\n  box-sizing: border-box;\n  line-height: 20px;\n}\n\nspan#hud-find-input,\nspan#hud-match-count {\n  display: inline;\n  outline: none;\n  white-space: nowrap;\n  overflow-y: hidden;\n}\n\nspan#hud-find-input:before {\n  content: \"/\";\n}\n\nspan#hud-match-count {\n  color: #aaa;\n  font-size: 12px;\n}\n\nspan#hud-find-input br {\n  display: none;\n}\n\nspan#hud-find-input * {\n  display: inline;\n  white-space: nowrap;\n}\n\n@media (prefers-color-scheme: light) {\n  #hud-body {\n    background-color: #f1f1f1;\n  }\n\n  /* This creates a border around the area where you type, which is nice effect on the light color\n   * scheme. It's hard to make this effect visible in dark mode, so we don't use it. */\n  #hud.hud-find {\n    background-color: white;\n    border: 1px solid #ccc;\n  }\n}\n\n/*\n * Styles for showing key bindings. Shared by help_dialog_page.html and command_listing.html.\n */\n\n.key-bindings {\n  max-width: 110px;\n  font-size: 14px;\n  text-align: right;\n  margin-right: 8px;\n  display: flex;\n  flex-wrap: wrap;\n  align-items: flex-end;\n  justify-content: flex-end;\n}\n\n/* A \"key block\" includes a key and a comma separator. */\n.key-block {\n  margin-bottom: 4px;\n}\n\n.key {\n  background-color: rgb(243, 243, 243);\n  color: rgb(33, 33, 33);\n  margin-left: 2px;\n  padding: 2px 6px;\n  border-radius: 3px;\n  border: solid 1px #ccc;\n  border-bottom-color: #bbb;\n  box-shadow: inset 0 -1px 0 #bbb;\n  font-family: monospace;\n  font-size: 11px;\n}\n\n.comma {\n  margin-right: 3px;\n}\n\n/* Hide the trailing comma after the last key binding. */\n.key-block:last-of-type .comma {\n  display: none;\n}\n\n@media (prefers-color-scheme: dark) {\n  .key {\n    /* We're using a color that pops more than --vimium-foreground-color because the squares\n       representing keys are small and hard to read otherwise. */\n    background-color: #393a3d;\n    border: solid 1px #101010;\n    box-shadow: none;\n    color: white;\n  }\n}\n\nbody {\n  font-family: \"Helvetica Neue\", Helvetica, Arial, sans-serif;\n}\n\n#container {\n  background-color: white;\n  border: 2px solid #b3b3b3;\n  border-radius: 6px;\n  width: 840px;\n  max-width: calc(100% - 100px);\n  max-height: calc(100% - 100px);\n  margin: 50px auto;\n  overflow-y: auto;\n  overflow-x: auto;\n}\n\n#dialog {\n  min-width: 600px;\n  padding: 8px 12px;\n}\n\na {\n  text-decoration: underline;\n  color: #2f508e;\n  cursor: pointer;\n}\n\nheader {\n  display: flex;\n  flex-direction: row;\n  align-items: center;\n}\n\na#close {\n  font-family: \"courier new\", monospace;\n  font-weight: bold;\n  color: #555;\n  text-decoration: none;\n  font-size: 24px;\n  position: relative;\n  top: 3px;\n  padding-left: 5px;\n  cursor: pointer;\n}\n\na#close:hover {\n  color: black;\n  -webkit-user-select: none;\n}\n\nh1 {\n  font-size: 20px;\n  white-space: nowrap;\n  flex-grow: 1;\n  font-weight: normal;\n  margin: 4px 0;\n}\n\nh1 .vim {\n  color: #2f508e;\n}\n\nheader a {\n  font-size: 14px;\n  padding-left: 5px;\n  padding-right: 5px;\n}\n\nheader a.close {\n  padding-right: 0;\n}\n\n#commands-section {\n  display: flex;\n  align-items: flex-start;\n  justify-content: space-between;\n}\n\n.column {\n  display: grid;\n  grid-template-columns: auto 1fr;\n  row-gap: 3px;\n}\n\nh2 {\n  margin-top: 3px;\n  margin-bottom: 4px;\n  font-size: 16px;\n  font-weight: bold;\n}\n\ndiv[data-group] {\n  display: contents;\n}\n\n.row {\n  display: contents;\n}\n\n.help-description {\n  font-size: 14px;\n}\n\ndiv.divider {\n  height: 1px;\n  width: 100%;\n  margin: 10px auto;\n  background-color: #9a9a9a;\n}\n\n/* Advanced commands are hidden by default until \"show advanced\" is clicked. */\n.row.advanced {\n  display: none;\n}\n\n#dialog.show-advanced .row.advanced {\n  display: contents;\n}\n\nfooter {\n  font-size: 10px;\n  display: flex;\n  justify-content: space-between;\n}\n\n.version-info {\n  text-align: right;\n}\n\n#toggle-advanced {\n  text-align: right;\n  font-size: 10px;\n}\n\n/* Dark Mode CSS for Help Dialog */\n@media (prefers-color-scheme: dark) {\n  #container {\n    border-color: rgba(255, 255, 255, 0.1);\n    background-color: #202124;\n  }\n\n  #dialog {\n    background-color: var(--vimium-background-color);\n    color: var(--vimium-background-text-color);\n  }\n\n  a {\n    color: var(--vimium-link-color);\n  }\n\n  h1,\n  h2 {\n    color: white;\n  }\n\n  h1 .vim {\n    color: var(--vimium-link-color);\n  }\n\n  div.divider {\n    background-color: rgba(255, 255, 255, 0.1);\n  }\n\n  .help-description {\n    /* Use a fainter color than --vimium-background-text-color, so the dialog text doesn't get\n       overwhelming. */\n    color: #c9cccf;\n  }\n}\n\n\n    /* Phantom Shadow DOM isolation & HUD/Help overrides */\n    :host {\n      all: initial;\n      position: absolute !important;\n      top: 0 !important;\n      left: 0 !important;\n      width: 0 !important;\n      height: 0 !important;\n      overflow: visible !important;\n      z-index: 2147483647 !important;\n      pointer-events: none !important;\n      font-family: \"Helvetica Neue\", Helvetica, Arial, sans-serif !important;\n    }\n    #phantom-vimium-root {\n      position: relative;\n      z-index: 2147483647;\n    }\n    #phantom-vimium-hud {\n      display: none;\n      position: fixed;\n      right: 16px;\n      bottom: 8px;\n      min-width: 260px;\n      max-width: 520px;\n      background-color: #1e2024;\n      color: #f1f3f5;\n      border: 1px solid #495057;\n      border-radius: 4px;\n      padding: 5px 10px;\n      font-family: \"Helvetica Neue\", Helvetica, Arial, sans-serif;\n      font-size: 13px;\n      line-height: 18px;\n      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);\n      z-index: 2147483647;\n      pointer-events: auto;\n      box-sizing: border-box;\n    }\n    #phantom-vimium-hud.visible {\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      gap: 10px;\n    }\n    #phantom-vimium-hud-text {\n      white-space: nowrap;\n      overflow: hidden;\n      text-overflow: ellipsis;\n    }\n    #phantom-vimium-find-wrap {\n      display: none;\n      align-items: center;\n      width: 100%;\n      gap: 6px;\n    }\n    #phantom-vimium-hud.find-mode #phantom-vimium-find-wrap {\n      display: flex;\n    }\n    #phantom-vimium-hud.find-mode #phantom-vimium-hud-text {\n      display: none;\n    }\n    #phantom-vimium-find-input {\n      flex: 1 1 auto;\n      min-width: 140px;\n      background: transparent;\n      border: none;\n      outline: none;\n      color: inherit;\n      font-family: inherit;\n      font-size: 13px;\n      padding: 0;\n      margin: 0;\n    }\n    #phantom-vimium-find-count {\n      color: #adb5bd;\n      font-size: 12px;\n      white-space: nowrap;\n    }\n    #phantom-vimium-help-backdrop {\n      display: none;\n      position: fixed;\n      inset: 0;\n      background: rgba(10, 12, 16, 0.72);\n      z-index: 2147483647;\n      pointer-events: auto;\n      overflow: auto;\n      padding: 36px 20px;\n      box-sizing: border-box;\n    }\n    #phantom-vimium-help-backdrop.visible {\n      display: block;\n    }\n    #phantom-vimium-help-dialog {\n      max-width: 820px;\n      margin: 0 auto;\n      background: #1f2228;\n      color: #e9ecef;\n      border: 1px solid #3d434e;\n      border-radius: 8px;\n      padding: 16px 20px;\n      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.65);\n      font-family: \"Helvetica Neue\", Helvetica, Arial, sans-serif;\n    }\n    #phantom-vimium-help-dialog header {\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      border-bottom: 1px solid #343a46;\n      padding-bottom: 10px;\n      margin-bottom: 12px;\n    }\n    #phantom-vimium-help-dialog h1 {\n      margin: 0;\n      font-size: 18px;\n      font-weight: 600;\n      color: #ffffff;\n    }\n    #phantom-vimium-help-close {\n      background: transparent;\n      border: 1px solid #4c5361;\n      color: #ced4da;\n      border-radius: 4px;\n      width: 26px;\n      height: 26px;\n      font-size: 16px;\n      line-height: 22px;\n      cursor: pointer;\n    }\n    #phantom-vimium-help-close:hover {\n      background: #343a46;\n      color: #ffffff;\n    }\n    .phantom-help-grid {\n      display: grid;\n      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));\n      gap: 16px 24px;\n    }\n    .phantom-help-group h2 {\n      margin: 0 0 8px 0;\n      font-size: 13px;\n      text-transform: uppercase;\n      letter-spacing: 0.05em;\n      color: #74c0fc;\n    }\n    .phantom-help-row {\n      display: flex;\n      align-items: baseline;\n      gap: 10px;\n      margin-bottom: 5px;\n      font-size: 13px;\n    }\n    .phantom-help-keys {\n      min-width: 96px;\n      text-align: right;\n      flex-shrink: 0;\n    }\n    .phantom-help-key {\n      display: inline-block;\n      background: #2f343d;\n      color: #f8f9fa;\n      border: 1px solid #495057;\n      border-radius: 3px;\n      padding: 1px 5px;\n      font-family: Consolas, monospace;\n      font-size: 11px;\n      margin-left: 3px;\n    }\n    .phantom-help-desc {\n      color: #ced4da;\n    }\n    ";

  const PhantomShadowUI = {
    hostEl: null,
    shadowRoot: null,
    containerEl: null,
    hudEl: null,
    hudTextEl: null,
    findInputEl: null,
    findCountEl: null,
    helpBackdropEl: null,
    styleTag: null,

    ensureMounted() {
      const targetRoot = document.documentElement || document.body;
      if (!targetRoot) {
        return null;
      }
      if (this.hostEl && this.hostEl.isConnected && this.shadowRoot) {
        return this.shadowRoot;
      }
      if (!this.hostEl) {
        this.hostEl = document.createElement("div");
        this.hostEl.id = "phantom-vimium-host";
        this.shadowRoot = this.hostEl.attachShadow({ mode: "closed" });

        this.styleTag = document.createElement("style");
        this.styleTag.id = "phantom-vimium-css";
        this.styleTag.textContent = VIMIUM_CSS;
        this.shadowRoot.appendChild(this.styleTag);

        this.containerEl = document.createElement("div");
        this.containerEl.id = "phantom-vimium-root";
        this.shadowRoot.appendChild(this.containerEl);

        this.buildHud();
        this.buildHelpDialog();
      }
      if (!this.hostEl.isConnected) {
        targetRoot.appendChild(this.hostEl);
      }
      return this.shadowRoot;
    },

    getContainer() {
      this.ensureMounted();
      return this.containerEl;
    },

    buildHud() {
      const hud = document.createElement("div");
      hud.id = "phantom-vimium-hud";

      const textSpan = document.createElement("span");
      textSpan.id = "phantom-vimium-hud-text";
      hud.appendChild(textSpan);

      const findWrap = document.createElement("div");
      findWrap.id = "phantom-vimium-find-wrap";

      const slash = document.createElement("span");
      slash.textContent = "/";
      findWrap.appendChild(slash);

      const input = document.createElement("input");
      input.id = "phantom-vimium-find-input";
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      findWrap.appendChild(input);

      const countSpan = document.createElement("span");
      countSpan.id = "phantom-vimium-find-count";
      findWrap.appendChild(countSpan);

      hud.appendChild(findWrap);
      this.containerEl.appendChild(hud);

      this.hudEl = hud;
      this.hudTextEl = textSpan;
      this.findInputEl = input;
      this.findCountEl = countSpan;
    },

    buildHelpDialog() {
      const backdrop = document.createElement("div");
      backdrop.id = "phantom-vimium-help-backdrop";

      const dialog = document.createElement("div");
      dialog.id = "phantom-vimium-help-dialog";

      const header = document.createElement("header");
      const title = document.createElement("h1");
      title.textContent = "Phantom Vimium Shortcuts";
      const closeBtn = document.createElement("button");
      closeBtn.id = "phantom-vimium-help-close";
      closeBtn.type = "button";
      closeBtn.textContent = "×";
      closeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        HelpDialog.abort();
      });
      header.appendChild(title);
      header.appendChild(closeBtn);
      dialog.appendChild(header);

      const grid = document.createElement("div");
      grid.className = "phantom-help-grid";
      const groups = [
        {
          title: "Scrolling & Page",
          items: [
            ["j / k", "Scroll down / up"],
            ["h / l", "Scroll left / right"],
            ["d / u", "Half page down / up"],
            ["gg / G", "Scroll to top / bottom"],
            ["0 / $", "Scroll all the way left / right"],
            ["r", "Reload page"]
          ]
        },
        {
          title: "Links & Inputs",
          items: [
            ["f", "Open link or control in current window"],
            ["F", "Open link in new window (if allowed)"],
            ["gi", "Focus first text input"],
            ["gf", "Cycle frame focus"],
            ["i / Esc / Ctrl+[", "Enter / exit Insert mode"]
          ]
        },
        {
          title: "Find & Visual",
          items: [
            ["/", "Find on page"],
            ["n / N", "Next / previous match"],
            ["v / V", "Enter Visual / Visual Line mode"],
            ["y", "Yank selection (respects clipboard policy)"],
            ["?", "Toggle this help overlay"]
          ]
        },
        {
          title: "History & Windows",
          items: [
            ["H / L", "Navigate back / forward"],
            ["J / gT", "Previous browser window"],
            ["K / gt", "Next browser window"],
            ["x", "Close secondary window"],
            ["Ctrl+Shift+V", "Toggle Vimium ON / OFF"]
          ]
        }
      ];

      for (const group of groups) {
        const section = document.createElement("div");
        section.className = "phantom-help-group";
        const h2 = document.createElement("h2");
        h2.textContent = group.title;
        section.appendChild(h2);

        for (const [keys, desc] of group.items) {
          const row = document.createElement("div");
          row.className = "phantom-help-row";
          const keysEl = document.createElement("div");
          keysEl.className = "phantom-help-keys";
          for (const part of keys.split(" / ")) {
            const k = document.createElement("span");
            k.className = "phantom-help-key";
            k.textContent = part;
            keysEl.appendChild(k);
          }
          const descEl = document.createElement("div");
          descEl.className = "phantom-help-desc";
          descEl.textContent = desc;
          row.appendChild(keysEl);
          row.appendChild(descEl);
          section.appendChild(row);
        }
        grid.appendChild(section);
      }

      dialog.appendChild(grid);
      backdrop.appendChild(dialog);
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) {
          HelpDialog.abort();
        }
      });
      this.containerEl.appendChild(backdrop);
      this.helpBackdropEl = backdrop;
    },

    cleanup() {
      try {
        if (this.hostEl && this.hostEl.parentNode) {
          this.hostEl.parentNode.removeChild(this.hostEl);
        }
        this.hostEl = null;
        this.shadowRoot = null;
        this.containerEl = null;
        this.hudEl = null;
        this.hudTextEl = null;
        this.findInputEl = null;
        this.findCountEl = null;
        this.helpBackdropEl = null;
      } catch (_err) {}
    }
  };

  // =========================================================================
  // Upstream Vimium Modules (in manifest.json load order)
  // =========================================================================
  // Only pass events to the handler if they are marked as trusted by the browser.
// This is kept in the global namespace for brevity and ease of use.


// Firefox does not have the storage.session API as of 2023-05-20. Until it does, use storage.local.
// Firefox 115 has beta support for storage.session, but this storage is not exposed to content
// scripts unless we use `setAccessLevel`, and that API is not yet implemented in Firefox 115.
if (chrome.storage.session == null || chrome.storage.session.setAccessLevel == null) {
  chrome.storage.session = chrome.storage.local;
  // Polyfill chrome.storage.session.setAccessLevel.
  chrome.storage.session.setAccessLevel = function () {};
}

const Utils = {
  debug: false,

  debugLog() {
    if (this.debug) {
      console.log.apply(console, arguments);
    }
  },

  // The Firefox browser name and version can only be reliably accessed from the browser page using
  // browser.runtime.getBrowserInfo(). This information is passed to the frontend via the
  // initializeFrame message, which sets each of these values. These values can also be set using
  // Utils.populateBrowserInfo().
  _browserInfoLoaded: false,
  _firefoxVersion: null,
  _isFirefox: null,

  // This should only be used by content scripts. Background pages should use BgUtils.isFirefox().
  isFirefox() {
    if (!this._browserInfoLoaded) {
      throw new Error("browserInfo has not yet loaded.");
    }
    return this._isFirefox;
  },

  // This should only be used by content scripts. Background pages should use
  // bg_utils.firefoxVersion().
  firefoxVersion() {
    if (!this._browserInfoLoaded) {
      throw new Error("browserInfo has not yet loaded.");
    }
    return this._firefoxVersion;
  },

  getCurrentVersion() {
    return chrome.runtime.getManifest().version;
  },

  async populateBrowserInfo() {
    if (this._browserInfoLoaded) {
      return;
    }
    const result = await chrome.runtime.sendMessage({ handler: "getBrowserInfo" });
    this._isFirefox = result.isFirefox;
    this._firefoxVersion = result.firefoxVersion;
    this._browserInfoLoaded = true;
  },

  // Escape all special characters, so RegExp will parse the string 'as is'.
  // Taken from http://stackoverflow.com/questions/3446170/escape-string-for-use-in-javascript-regex
  escapeRegexSpecialCharacters: (function () {
    const escapeRegex = /[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g;
    return (str) => str.replace(escapeRegex, "\\$&");
  })(),

  escapeHtml(string) {
    return string.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  },

  // Generates a unique ID
  createUniqueId: (function () {
    let id = 0;
    return () => id += 1;
  })(),

  // Decode valid escape sequences in a URI. This is intended to mimic the best-effort decoding
  // Chrome itself seems to apply when a Javascript URI is enetered into the omnibox (or clicked).
  // See https://code.google.com/p/chromium/issues/detail?id=483000, #1611 and #1636.
  decodeURIByParts(uri) {
    return uri.split(/(?=%)/).map(function (uriComponent) {
      try {
        return decodeURIComponent(uriComponent);
      } catch {
        return uriComponent;
      }
    }).join("");
  },

  // Extract a query from url if it appears to be a URL created from the given search URL.
  // For example, map "https://www.google.ie/search?q=star+wars&foo&bar" to "star wars".
  // TODO(philc): Currently unused; delete.
  extractQuery: (() => {
    const queryTerminator = new RegExp("[?&#/]");
    const httpProtocolRegexp = new RegExp("^https?://");
    return function (searchUrl, url) {
      let suffixTerms;
      url = url.replace(httpProtocolRegexp);
      searchUrl = searchUrl.replace(httpProtocolRegexp);
      [searchUrl, ...suffixTerms] = searchUrl.split("%s");
      // We require the URL to start with the search URL.
      if (!url.startsWith(searchUrl)) {
        return null;
      }
      // We require any remaining terms in the search URL to also be present in the URL.
      for (const suffix of suffixTerms) {
        if (!(0 <= url.indexOf(suffix))) {
          return null;
        }
      }
      // We use try/catch because decodeURIComponent can throw an exception.
      try {
        return url.slice(searchUrl.length).split(queryTerminator)[0].split("+").map(
          decodeURIComponent,
        ).join(" ");
      } catch {
        return null;
      }
    };
  })(),

  // detects both literals and dynamically created strings
  // TODO(philc): There's only one caller. Inline this.
  isString(obj) {
    return (typeof obj === "string") || obj instanceof String;
  },

  // Transform "zjkjkabz" into "abjkz".
  distinctCharacters(str) {
    const chars = str.split("");
    return Array.from(new Set(chars)).sort().join("");
  },

  // Compares two version strings (e.g. "1.1" and "1.5") and returns
  // -1 if versionA is < versionB, 0 if they're equal, and 1 if versionA is > versionB.
  compareVersions(versionA, versionB) {
    versionA = versionA.split(".");
    versionB = versionB.split(".");
    for (let i = 0, end = Math.max(versionA.length, versionB.length); i < end; i++) {
      const a = parseInt(versionA[i] || 0, 10);
      const b = parseInt(versionB[i] || 0, 10);
      if (a < b) {
        return -1;
      } else if (a > b) {
        return 1;
      }
    }
    return 0;
  },

  // Group items in an array by a key function. Inspired by lodash's implementation.
  // - key: either a string property name, or a function which takes an item from the array and
  //   returns the value of a key.
  // Example: keyBy([{ k: "a" }, { k: "b" }], "k") =>
  //   {
  //     "a": { k: "a" },
  //     "b": { k: "b" },
  //   }
  keyBy(array, key) {
    return array.reduce((result, item) => {
      const keyValue = typeof key === "function" ? key(item) : item[key];
      result[keyValue] = item;
      return result;
    }, {});
  },

  // Zip two (or more) arrays:
  //   - Utils.zip([ [a,b], [1,2] ]) returns [ [a,1], [b,2] ]
  //   - Length of result is `arrays[0].length`.
  //   - Adapted from:
  //     http://stackoverflow.com/questions/4856717/javascript-equivalent-of-pythons-zip-function
  zip(arrays) {
    return arrays[0].map((_, i) => arrays.map((array) => array[i]));
  },

  // Returns a copy of `object`, but only with the properties in `propertyList`.
  pick(object, propertyList) {
    const result = {};
    for (const property of propertyList) {
      if (Object.prototype.hasOwnProperty.call(object, property)) {
        result[property] = object[property];
      }
    }
    return result;
  },

  // locale-sensitive uppercase detection
  hasUpperCase(s) {
    return s.toLowerCase() !== s;
  },

  // Does string match any of these regexps?
  matchesAnyRegexp(regexps, string) {
    for (const re of regexps) {
      if (re.test(string)) {
        return true;
      }
    }
    return false;
  },

  // Convenience wrapper for setTimeout (with the arguments around the other way).
  setTimeout(ms, func) {
    return setTimeout(func, ms);
  },

  // Like Nodejs's nextTick.
  nextTick(func) {
    return this.setTimeout(0, func);
  },

  promiseWithTimeout(promise, ms) {
    const timeoutPromise = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Promise timed out after ${ms}ms.`)), ms);
    });
    return Promise.race([promise, timeoutPromise]);
  },

  // Make an idempotent function.
  makeIdempotent(func) {
    return function (...args) {
      // TODO(philc): Clean up this transpiled code.
      let _, ref;
      const result = ([_, func] = Array.from(ref = [func, null]), ref)[0];
      if (result) {
        return result(...Array.from(args || []));
      }
    };
  },

  monitorChromeSessionStorage(key, setter) {
    return chrome.storage.session.get(key, (obj) => {
      if (obj[key] != null) {
        setter(obj[key]);
      }
      return chrome.storage.onChanged.addListener((changes, _area) => {
        if (changes[key] && (changes[key].newValue !== undefined)) {
          return setter(changes[key].newValue);
        }
      });
    });
  },

  // Logs a backtrace when an assertion fails, and also halts execution by throwing an error. We do
  // both, because logged objects in console.assert are easier to read from the DevTools console
  // than just the output from an error.
  assert(expression, ...messages) {
    console.assert.apply(console, [expression].concat(messages));
    if (!expression) {
      throw new Error(messages.join(" "));
    }
  },

  // This is a wrapper around chrome.runtime.onMessage.addListener.
  // As of 2023-06-26 Chrome doesn't support passing an async function argument to the addListener
  // function. If you do, the return value to the caller of chrome.runtime.sendMessage is always
  // null. To work around this, we use an anonymous async function inside the handler that we
  // pass to addListener.
  // See here for workarounds: https://stackoverflow.com/q/44056271
  // Also see MDN's page on runtime.onMessage regarding "responding with a Promise.
  // - listenerFn: this can be async, and can return a value to the message sender.
  // - requestsHandled: a list of strings indicating which request types this listener will handle.
  //   The request type is indicated by request.handler. This is required because, while most
  //   message types are handled by just one listener (in vimium_frontend.js, or
  //   background_scripts/main.js), when the current page is a background page (like the Options
  //   page, or the Help dialog), then both listeners will receive all message types, and so each
  //   message handler must be able to distinguish which message types to respond to.
  addChromeRuntimeOnMessageListener(requestsHandled, listenerFn) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      Utils.assert(request.handler != null, "Request is missing handler", request);
      if (!requestsHandled.includes(request.handler)) {
        return false; // Signal that we will not handle this message.
      }
      (async function () {
        const result = await listenerFn(request, sender);
        sendResponse(result);
      })();
      return true; // Indicate that we will be calling sendResponse, asynchronously.
    });
  },

  // Throws an error if object is null, or has properties which don't match the provided schema.
  // This is like a minimal version of the Zod library.
  //
  // - schema: a map describing the desired shape of the object. E.g.
  //   { name: "string", age: "number" }. Properites are allowed to be nulls, which means
  //   if an object is missing a property, it's not an error.
  // - o: the object to validate
  assertType(schema, o) {
    const typeCheckers = {
      boolean: (v) => typeof v === "boolean",
      number: (v) => typeof v === "number",
      string: (v) => typeof v === "string",
    };
    if (schema == null) {
      throw new Error("The schema argument is required.");
    }
    if (o == null) {
      throw new Error("The object argument is required.");
    }
    for (const key of Object.keys(o)) {
      if (!Object.hasOwn(schema, key)) {
        throw new TypeError(`Object has unexpected property named "${key}": ${o}`);
      }
      const _type = schema[key];
      // A null type means no assertion on the actual type, just that the object property is allowed
      // to exist.
      if (_type == null) {
        continue;
      }
      if (!Object.hasOwn(typeCheckers, _type)) {
        throw new Exception(`Schema contains an unknown type: ${key} with type ${_type}.`);
      }
      const val = o[key];
      if (val == null) {
        continue;
      } // By default all values are allowd to be null.
      if (!typeCheckers[_type](val)) {
        throw new TypeError(
          `Object property ${key} is expected to be type ${_type} but it's ${typeof val}: ${val}`,
        );
      }
    }
  },
};

Array.copy = (array) => Array.prototype.slice.call(array, 0);

if (!String.prototype.reverse) { Object.defineProperty(String.prototype, "reverse", { value: function () { return this.split("").reverse().join(""); }, configurable: true, writable: true }); }

// A cache. Entries used within two expiry periods are retained, otherwise they are discarded. At
// most 2 * maxEntries are retained.
// TODO(philc): Why is this capped at 2*maxEntries rather than maxEntries?
class SimpleCache {
  // - expiry: expiry time in milliseconds (default, one hour)
  // - maxEntries: maximum number of entries in the `cache` (there may be up to this many entries in
  //   `previous`, too)
  constructor(expiry, maxEntries) {
    if (expiry == null) {
      expiry = 60 * 60 * 1000;
    }
    this.expiry = expiry;
    if (maxEntries == null) {
      maxEntries = 1000;
    }
    this.maxEntries = maxEntries;
    this.cache = {};
    this.previous = {};
    this.lastRotation = new Date();
  }

  has(key) {
    this.rotate();
    return (key in this.cache) || key in this.previous;
  }

  // Set value, and return that value.  If value is null, then delete key.
  set(key, value = null) {
    this.rotate();
    delete this.previous[key];
    if (value != null) {
      return this.cache[key] = value;
    } else {
      delete this.cache[key];
      return null;
    }
  }

  get(key) {
    this.rotate();
    if (key in this.cache) {
      return this.cache[key];
    } else if (key in this.previous) {
      this.cache[key] = this.previous[key];
      delete this.previous[key];
      return this.cache[key];
    } else {
      return null;
    }
  }

  rotate(force) {
    if (force == null) {
      force = false;
    }
    Utils.nextTick(() => {
      if (
        force || (this.maxEntries < Object.keys(this.cache).length) ||
        (this.expiry < (new Date() - this.lastRotation))
      ) {
        this.lastRotation = new Date();
        this.previous = this.cache;
        return this.cache = {};
      }
    });
  }

  clear() {
    this.rotate(true);
    return this.rotate(true);
  }
}

// Mixin functions for enabling a class to dispatch methods.
const EventDispatcher = {
  addEventListener(eventName, listener) {
    this.events = this.events || [];
    this.events[eventName] = this.events[eventName] || [];
    this.events[eventName].push(listener);
  },

  dispatchEvent(eventName) {
    this.events = this.events || [];
    for (const listener of this.events[eventName] || []) {
      listener();
    }
  },

  removeEventListener(eventName, listener) {
    const events = this.events || {};
    const listeners = events[eventName] || [];
    if (listeners.length > 0) {
      events[eventName] = listeners.filter((l) => l != listener);
    }
  },
};



  let mapKeyRegistry = {};
Utils.monitorChromeSessionStorage("mapKeyRegistry", (value) => {
  return mapKeyRegistry = value;
});

const KeyboardUtils = {
  // This maps event.key key names to Vimium key names.
  keyNames: {
    "ArrowLeft": "left",
    "ArrowUp": "up",
    "ArrowRight": "right",
    "ArrowDown": "down",
    " ": "space",
    "\n": "enter", // on a keypress event of Ctrl+Enter, tested on Chrome 92 and Windows 10
  },

  init() {
    // TODO(philc): Remove this guard clause once Deno has a userAgent.
    // https://github.com/denoland/deno/issues/14362
    // As of 2022-04-30, Deno does not have userAgent defined on navigator.
    if (navigator.userAgent == null) {
      this.platform = "Unknown";
      return;
    }
    if (navigator.userAgent.indexOf("Mac") !== -1) {
      this.platform = "Mac";
    } else if (navigator.userAgent.indexOf("Linux") !== -1) {
      this.platform = "Linux";
    } else {
      this.platform = "Windows";
    }
  },

  getKeyChar(event) {
    let key;
    const canUseEventKey = !Settings.get("ignoreKeyboardLayout") &&
      // On MacOS, when alt (option) is pressed, event.key is a symbol. E.g. the <a-c> key press
      // yields ç. In such cases, use event.code instead to identify which key was pressed, so that
      // the user can intuitively map <a-c> in their keymappings, rather than <a-ç>. See #3197.
      !(this.platform == "Mac" && event.altKey);

    if (canUseEventKey) {
      key = event.key;
    } else if (!event.code) {
      key = event.key != null ? event.key : ""; // Fall back to event.key (see #3099).
    } else if (event.code.slice(0, 6) === "Numpad") {
      // We cannot correctly emulate the numpad, so fall back to event.key; see #2626.
      key = event.key;
    } else {
      // The logic here is from the vim-like-key-notation project
      // (https://github.com/lydell/vim-like-key-notation).
      key = event.code;
      if (key.slice(0, 3) === "Key") {
        key = key.slice(3);
      }
      // Translate some special keys to event.key-like strings and handle <Shift>.
      if (this.enUsTranslations[key]) {
        key = event.shiftKey ? this.enUsTranslations[key][1] : this.enUsTranslations[key][0];
      } else if ((key.length === 1) && !event.shiftKey) {
        key = key.toLowerCase();
      }
    }

    // It appears that key is not always defined (see #2453).
    if (!key) {
      return "";
    } else if (key in this.keyNames) {
      return this.keyNames[key];
    } else if (this.isModifier(event)) {
      return ""; // Don't resolve modifier keys.
    } else if (key.length === 1) {
      return key;
    } else {
      return key.toLowerCase();
    }
  },

  getKeyCharString(event) {
    let keyChar = this.getKeyChar(event);
    if (!keyChar) {
      return;
    }

    const modifiers = [];

    if (event.shiftKey && (keyChar.length === 1)) {
      keyChar = keyChar.toUpperCase();
    }
    // These must be in alphabetical order (to match the sorted modifier order in
    // Commands.normalizeKey).
    if (event.altKey) {
      modifiers.push("a");
    }
    if (event.ctrlKey) {
      modifiers.push("c");
    }
    if (event.metaKey) {
      modifiers.push("m");
    }
    if (event.shiftKey && (keyChar.length > 1)) {
      modifiers.push("s");
    }

    keyChar = [...modifiers, keyChar].join("-");
    if (1 < keyChar.length) {
      keyChar = `<${keyChar}>`;
    }
    keyChar = mapKeyRegistry[keyChar] != null ? mapKeyRegistry[keyChar] : keyChar;
    return keyChar;
  },

  isEscape: (function () {
    let useVimLikeEscape = true;
    Utils.monitorChromeSessionStorage("useVimLikeEscape", (value) => useVimLikeEscape = value);

    return function (event) {
      // <c-[> is mapped to Escape in Vim by default.
      // Escape with a keyCode 229 means that this event comes from IME, and should not be treated
      // as a direct/normal Escape event. IME will handle the event, not vimium.
      // See https://lists.w3.org/Archives/Public/www-dom/2010JulSep/att-0182/keyCode-spec.html
      return ((event.key === "Escape") && (event.keyCode !== 229)) ||
        (useVimLikeEscape && (this.getKeyCharString(event) === "<c-[>"));
    };
  })(),

  isBackspace(event) {
    return ["Backspace", "Delete"].includes(event.key);
  },

  isPrintable(event) {
    const s = this.getKeyCharString(event);
    return s && s.length == 1;
  },

  isModifier(event) {
    return ["Control", "Shift", "Alt", "OS", "AltGraph", "Meta"].includes(event.key);
  },

  enUsTranslations: {
    "Backquote": ["`", "~"],
    "Minus": ["-", "_"],
    "Equal": ["=", "+"],
    "Backslash": ["\\", "|"],
    "IntlBackslash": ["\\", "|"],
    "BracketLeft": ["[", "{"],
    "BracketRight": ["]", "}"],
    "Semicolon": [";", ":"],
    "Quote": ["'", '"'],
    "Comma": [",", "<"],
    "Period": [".", ">"],
    "Slash": ["/", "?"],
    "Space": [" ", " "],
    "Digit1": ["1", "!"],
    "Digit2": ["2", "@"],
    "Digit3": ["3", "#"],
    "Digit4": ["4", "$"],
    "Digit5": ["5", "%"],
    "Digit6": ["6", "^"],
    "Digit7": ["7", "&"],
    "Digit8": ["8", "*"],
    "Digit9": ["9", "("],
    "Digit0": ["0", ")"],
  },
};

KeyboardUtils.init();


  const DomUtils = {
  //
  // Runs :callback if the DOM has loaded, otherwise runs it on load
  //
  isReady() {
    return document.readyState !== "loading";
  },

  // Returns a promise which resolves when the DOMContentLoaded event has been fired.
  documentReady() {
    return new Promise((resolve) => {
      if (this.isReady()) {
        resolve();
        return;
      }
      globalThis.addEventListener("DOMContentLoaded", forTrusted(resolve));
    });
  },

  // Returns a promise which resolves when the load event has been fired.
  documentComplete() {
    return new Promise((resolve) => {
      const isComplete = document.readyState === "complete";
      if (isComplete) {
        resolve();
        return;
      }
      const handler = forTrusted((event) => {
        // TODO(philc): Is this event.target check necessary? Why do we have it?
        // The target is ensured to be on document. See
        // https://w3c.github.io/uievents/#event-type-load
        if (event.target !== document) {
          return;
        }
        resolve();
      });
      globalThis.addEventListener("load", handler);
    });
  },

  // TODO(philc): Why is this necessary? Find the introducing commit and document it.
  createElement(tagName) {
    const element = document.createElement(tagName);
    if (element instanceof HTMLElement) {
      // The document namespace provides (X)HTML elements, so we can use them directly.
      this.createElement = (tagName) => document.createElement(tagName);
      return element;
    } else {
      // The document namespace doesn't give (X)HTML elements, so we create them with the correct
      // namespace manually.
      this.createElement = (tagName) =>
        document.createElementNS("http://www.w3.org/1999/xhtml", tagName);
      return this.createElement(tagName);
    }
  },

  //
  // Remove an element from its DOM tree.
  //
  removeElement(el) { return el && el.parentNode ? el.parentNode.removeChild(el) : null; },

  //
  // Test whether the current frame is the top/main frame.
  //
  isTopFrame() {
    return globalThis.top === globalThis.self;
  },

  //
  // Takes an array of XPath selectors, adds the necessary namespaces (currently only XHTML), and
  // applies them to the document root. The namespaceResolver in evaluateXPath should be kept in
  // sync with the namespaces here.
  //
  makeXPath(elementArray) {
    const xpath = [];
    for (const element of elementArray) {
      xpath.push(".//" + element, ".//xhtml:" + element);
    }
    return xpath.join(" | ");
  },

  // Evaluates an XPath on the whole document, or on the contents of the fullscreen element if an
  // element is fullscreen.
  evaluateXPath(xpath, resultType) {
    const contextNode = document.webkitIsFullScreen
      ? document.webkitFullscreenElement
      : document.documentElement;
    const namespaceResolver = function (namespace) {
      if (namespace === "xhtml") {
        return "http://www.w3.org/1999/xhtml";
      } else {
        return null;
      }
    };
    return document.evaluate(xpath, contextNode, namespaceResolver, resultType, null);
  },

  //
  // Returns the first visible clientRect of an element if it exists. Otherwise it returns null.
  //
  // WARNING: If testChildren = true then the rects of visible (eg. floated) children may be
  // returned instead. This is used for LinkHints and focusInput, **BUT IS UNSUITABLE FOR MOST OTHER
  // PURPOSES**.
  //
  getVisibleClientRect(element, testChildren) {
    // Note: this call will be expensive if we modify the DOM in between calls.
    let clientRect;
    if (testChildren == null) {
      testChildren = false;
    }
    const clientRects = (() => {
      const result = [];
      for (clientRect of element.getClientRects()) {
        result.push(Rect.copy(clientRect));
      }
      return result;
    })();

    // Inline elements with font-size: 0px; will declare a height of zero, even if a child with
    // non-zero font-size contains text.
    let isInlineZeroHeight = function () {
      const elementComputedStyle = globalThis.getComputedStyle(element, null);
      const isInlineZeroFontSize =
        (0 === elementComputedStyle.getPropertyValue("display").indexOf("inline")) &&
        (elementComputedStyle.getPropertyValue("font-size") === "0px");
      // Override the function to return this value for the rest of this context.
      isInlineZeroHeight = () => isInlineZeroFontSize;
      return isInlineZeroFontSize;
    };

    for (clientRect of clientRects) {
      // If the link has zero dimensions, it may be wrapping visible but floated elements. Check for
      // this.
      let computedStyle;
      if (((clientRect.width === 0) || (clientRect.height === 0)) && testChildren) {
        for (const child of Array.from(element.children)) {
          computedStyle = globalThis.getComputedStyle(child, null);
          // Ignore child elements which are not floated and not absolutely positioned for parent
          // elements with zero width/height, as long as the case described at isInlineZeroHeight
          // does not apply.
          // NOTE(mrmr1993): This ignores floated/absolutely positioned descendants nested within
          // inline children.
          const position = computedStyle.getPropertyValue("position");
          if (
            (computedStyle.getPropertyValue("float") === "none") &&
            !(["absolute", "fixed"].includes(position)) &&
            !((clientRect.height === 0) && isInlineZeroHeight() &&
              (0 === computedStyle.getPropertyValue("display").indexOf("inline")))
          ) {
            continue;
          }
          const childClientRect = this.getVisibleClientRect(child, true);
          if (
            (childClientRect === null) || (childClientRect.width < 3) ||
            (childClientRect.height < 3)
          ) {
            continue;
          }
          return childClientRect;
        }
      } else {
        clientRect = this.cropRectToVisible(clientRect);

        if ((clientRect === null) || (clientRect.width < 3) || (clientRect.height < 3)) {
          continue;
        }

        // eliminate invisible elements (see test_harnesses/visibility_test.html)
        computedStyle = globalThis.getComputedStyle(element, null);
        if (computedStyle.getPropertyValue("visibility") !== "visible") {
          continue;
        }

        return clientRect;
      }
    }

    return null;
  },

  //
  // Bounds the rect by the current viewport dimensions. If the rect is offscreen or has a height or
  // width < 3 then null is returned instead of a rect.
  //
  cropRectToVisible(rect) {
    const boundedRect = Rect.create(
      Math.max(rect.left, 0),
      Math.max(rect.top, 0),
      rect.right,
      rect.bottom,
    );
    if (
      (boundedRect.top >= (globalThis.innerHeight - 4)) ||
      (boundedRect.left >= (globalThis.innerWidth - 4))
    ) {
      return null;
    } else {
      return boundedRect;
    }
  },

  //
  // Get the client rects for the <area> elements in a <map> based on the position of the <img>
  // element using the map. Returns an array of rects.
  //
  getClientRectsForAreas(imgClientRect, areaEls) {
    const rects = [];
    for (const areaEl of areaEls) {
      let x1, x2, y1, y2;
      const coords = areaEl.coords.split(",").map((coord) => parseInt(coord, 10));
      const shape = areaEl.shape.toLowerCase();
      if (["rect", "rectangle"].includes(shape)) { // "rectangle" is an IE non-standard.
        if (coords.length == 4) {
          [x1, y1, x2, y2] = coords;
        }
      } else if (["circle", "circ"].includes(shape)) { // "circ" is an IE non-standard.
        if (coords.length == 3) {
          const [x, y, r] = coords;
          const diff = r / Math.sqrt(2); // Gives us an inner square
          x1 = x - diff;
          x2 = x + diff;
          y1 = y - diff;
          y2 = y + diff;
        }
      } else if (shape === "default") {
        if (coords.length == 2) {
          [x1, y1, x2, y2] = [0, 0, imgClientRect.width, imgClientRect.height];
        }
      } else {
        if (coords.length >= 4) {
          // Just consider the rectangle surrounding the first two points in a polygon. It's
          // possible to do something more sophisticated, but likely not worth the effort.
          [x1, y1, x2, y2] = coords;
        }
      }

      let rect = Rect.translate(Rect.create(x1, y1, x2, y2), imgClientRect.left, imgClientRect.top);
      rect = this.cropRectToVisible(rect);

      // The wrong numbere of coords in a <map> element, or malformed numbers, can result in NaN
      // values.
      const isValid = rect && !isNaN(rect.top) && !isNaN(rect.left) && !isNaN(rect.width) &&
        !isNaN(rect.height);
      if (isValid) {
        rects.push({ element: areaEl, rect });
      }
    }
    return rects;
  },

  //
  // Selectable means that we should use the simulateSelect method to activate the element instead
  // of a click.
  //
  // The html5 input types that should use simulateSelect are:
  //   ["date", "datetime", "datetime-local", "email", "month", "number", "password", "range",
  //    "search", "tel", "text", "time", "url", "week"]
  // An unknown type will be treated the same as "text", in the same way that the browser does.
  //
  isSelectable(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const unselectableTypes = [
      "button",
      "checkbox",
      "color",
      "file",
      "hidden",
      "image",
      "radio",
      "reset",
      "submit",
    ];
    return ((element.nodeName.toLowerCase() === "input") &&
      (unselectableTypes.indexOf(element.type) === -1)) ||
      (element.nodeName.toLowerCase() === "textarea") || element.isContentEditable;
  },

  // Input or text elements are considered focusable and able to receieve their own keyboard events,
  // and will enter insert mode if focused. Also note that the "contentEditable" attribute can be
  // set on any element which makes it a rich text editor, like the notes on jjot.com.
  isEditable(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }
    if (document.designMode === "on") {
      return true;
    }
    const role = element.getAttribute("role");
    if (role && ["textbox", "searchbox", "combobox"].includes(role.toLowerCase())) {
      return true;
    }
    if (element.closest && element.closest(".monaco-editor, .CodeMirror, .cm-editor, .cm-content, .ace_editor, .ql-editor, .tox-edit-area, .mce-content-body")) {
      return true;
    }
    return (this.isSelectable(element)) ||
      ((element.nodeName != null ? element.nodeName.toLowerCase() : undefined) === "select");
  },

  // Embedded elements like Flash and quicktime players can obtain focus.
  isEmbed(element) {
    const nodeName = element.nodeName != null ? element.nodeName.toLowerCase() : null;
    return ["embed", "object"].includes(nodeName);
  },

  isFocusable(element) {
    return element && (this.isEditable(element) || this.isEmbed(element));
  },

  isDOMDescendant(parent, child) {
    let node = child;
    while (node !== null) {
      if (node === parent) {
        return true;
      }
      node = node.parentNode;
    }
    return false;
  },

  // True if element is editable and contains the active selection range.
  isSelected(element) {
    const selection = document.getSelection();
    if (element.isContentEditable) {
      const node = selection.anchorNode;
      return node && this.isDOMDescendant(element, node);
    }

    if ((selection.type === "Range") && selection.isCollapsed) {
      // The selection is inside the Shadow DOM of a node. We can check the node it registers as
      // being before, since this represents the node whose Shadow DOM it's inside.
      const containerNode = selection.anchorNode.childNodes[selection.anchorOffset];
      // True if the selection is inside the Shadow DOM of our element.
      return element === containerNode;
    }

    return false;
  },

  simulateSelect(element) {
    // If element is already active, then we don't move the selection. However, we also won't get a
    // new focus event. So, instead we pretend (to any active modes which care, e.g. PostFindMode)
    // that element has been clicked.
    if ((element === document.activeElement) && DomUtils.isEditable(document.activeElement)) {
      return handlerStack.bubbleEvent("click", { target: element });
    } else {
      element.focus();
      if ((element.tagName.toLowerCase() !== "textarea") || (element.value.indexOf("\n") < 0)) {
        // If the cursor is at the start of the (non-multiline-textarea) element's contents, send it
        // to the end.
        // Motivation:
        // * the end is a more useful place to focus than the start,
        // * this way preserves the last used position (except when it's at the beginning), so the
        //   user can 'resume where they left off'.
        // This works well for single-line inputs, however, the UX is *bad* for multiline inputs
        // (such as text areas), and doubly so if the end of the input happens to be out of the
        // viewport, that's why multiline-textareas are excluded.
        // NOTE(mrmr1993): Some elements throw an error when we try to access their selection
        // properties, so wrap this with a try.
        try {
          if ((element.selectionStart === 0) && (element.selectionEnd === 0)) {
            return element.setSelectionRange(element.value.length, element.value.length);
          }
        } catch {
          // Swallow
        }
      }
    }
  },

  simulateClick(element, modifiers) {
    if (modifiers == null) {
      modifiers = {};
    }
    const eventSequence = [
      "pointerover",
      "mouseover",
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
    ];
    for (const event of eventSequence) {
      this.simulateMouseEvent(event, element, modifiers);
    }
  },

  // Simulates the events of a real double click: two presses, each ending in a click, and then a
  // dblclick. Some pages, like Google Drive, ignore a dblclick event which isn't preceded by a
  // second click with `detail: 2`.
  simulateDoubleClick(element, modifiers) {
    this.simulateMouseEvent("pointerover", element, modifiers);
    this.simulateMouseEvent("mouseover", element, modifiers);
    const pressSequence = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    for (const clickCount of [1, 2]) {
      for (const event of pressSequence) {
        this.simulateMouseEvent(event, element, modifiers, clickCount);
      }
    }
    this.simulateMouseEvent("dblclick", element, modifiers, 2);
  },

  // Returns false if the event is cancellable and one of the handlers called
  // event.preventDefault().
  // - clickCount: the event's `detail`, which is the number of clicks in quick succession.
  simulateMouseEvent(event, element, modifiers, clickCount = 1) {
    if (modifiers == null) {
      modifiers = {};
    }
    if (event === "mouseout") {
      // Allow unhovering the last hovered element by passing undefined.
      if (element == null) {
        element = this.lastHoveredElement;
      }
      this.lastHoveredElement = undefined;
      if (element == null) {
        return;
      }
    } else if (event === "mouseover") {
      // Simulate moving the mouse off the previous element first, as if we were a real mouse.
      this.simulateMouseEvent("mouseout", undefined, modifiers);
      this.lastHoveredElement = element;
    }

    const mouseEvent = new MouseEvent(event, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: clickCount,
      ctrlKey: modifiers.ctrlKey,
      altKey: modifiers.altKey,
      shiftKey: modifiers.shiftKey,
      metaKey: modifiers.metaKey,
    });
    return element.dispatchEvent(mouseEvent);
  },

  simulateClickDefaultAction(element, modifiers) {
    let newTabModifier;
    if (modifiers == null) {
      modifiers = {};
    }
    if (
      ((element.tagName != null ? element.tagName.toLowerCase() : undefined) !== "a") ||
      !element.href
    ) {
      return;
    }

    const { ctrlKey, shiftKey, metaKey, altKey } = modifiers;

    // Mac uses a different new tab modifier (meta vs. ctrl).
    if (KeyboardUtils.platform === "Mac") {
      newTabModifier = (metaKey === true) && (ctrlKey === false);
    } else {
      newTabModifier = (metaKey === false) && (ctrlKey === true);
    }

    if (newTabModifier) {
      // Open in new tab. Shift determines whether the tab is focused when created. Alt is ignored.
      chrome.runtime.sendMessage({
        handler: "openUrlInNewTab",
        url: element.href,
        active: shiftKey === true,
      });
    } else if (
      (shiftKey === true) && (metaKey === false) && (ctrlKey === false) && (altKey === false)
    ) {
      // Open in new window.
      chrome.runtime.sendMessage({ handler: "openUrlInNewWindow", url: element.href });
    } else if (element.target === "_blank") {
      chrome.runtime.sendMessage({ handler: "openUrlInNewTab", url: element.href, active: true });
    }
  },

  simulateHover(element, modifiers) {
    if (modifiers == null) {
      modifiers = {};
    }
    return this.simulateMouseEvent("mouseover", element, modifiers);
  },

  simulateUnhover(element, modifiers) {
    if (modifiers == null) {
      modifiers = {};
    }
    return this.simulateMouseEvent("mouseout", element, modifiers);
  },

  addFlashRect(rect) {
    const flashEl = this.createElement("div");
    flashEl.classList.add("vimium-reset");
    flashEl.classList.add("vimium-flash");
    flashEl.style.left = rect.left + "px";
    flashEl.style.top = rect.top + "px";
    flashEl.style.width = rect.width + "px";
    flashEl.style.height = rect.height + "px";
    PhantomShadowUI.getContainer().appendChild(flashEl);
    return flashEl;
  },

  getViewportTopLeft() {
    const box = document.documentElement;
    const style = getComputedStyle(box);
    const rect = box.getBoundingClientRect();
    if ((style.position === "static") && !/content|paint|strict/.test(style.contain || "")) {
      // The margin is included in the client rect, so we need to subtract it back out.
      const marginTop = parseInt(style.marginTop);
      const marginLeft = parseInt(style.marginLeft);
      return { top: -rect.top + marginTop, left: -rect.left + marginLeft };
    } else {
      let clientLeft, clientTop;
      if (Utils.isFirefox()) {
        // These are always 0 for documentElement on Firefox, so we derive them from CSS border.
        clientTop = parseInt(style.borderTopWidth);
        clientLeft = parseInt(style.borderLeftWidth);
      } else {
        ({ clientTop, clientLeft } = box);
      }
      return { top: -rect.top - clientTop, left: -rect.left - clientLeft };
    }
  },

  suppressPropagation(event) {
    event.stopImmediatePropagation();
  },

  suppressEvent(event) {
    event.preventDefault();
    this.suppressPropagation(event);
  },

  consumeKeyup: (function () {
    let handlerId = null;

    return function (event, callback = null, suppressPropagation) {
      if (!event.repeat) {
        if (handlerId != null) {
          handlerStack.remove(handlerId);
        }
        const {
          code,
        } = event;
        handlerId = handlerStack.push({
          _name: "dom_utils/consumeKeyup",
          keyup(event) {
            if (event.code !== code) {
              return handlerStack.continueBubbling;
            }
            this.remove();
            if (suppressPropagation) {
              DomUtils.suppressPropagation(event);
            } else {
              DomUtils.suppressEvent(event);
            }
            return handlerStack.continueBubbling;
          },
          // We cannot track keyup events if we lose the focus.
          blur(event) {
            if (event.target === window) {
              this.remove();
            }
            return handlerStack.continueBubbling;
          },
        });
      }
      if (typeof callback === "function") {
        callback();
      }
      if (suppressPropagation) {
        DomUtils.suppressPropagation(event);
        return handlerStack.suppressPropagation;
      } else {
        DomUtils.suppressEvent(event);
        return handlerStack.suppressEvent;
      }
    };
  })(),

  // Adapted from: http://roysharon.com/blog/37.
  // This finds the element containing the selection focus.
  getElementWithFocus(selection, backwards) {
    let t;
    let r = (t = selection.getRangeAt(0));
    if (selection.type === "Range") {
      r = t.cloneRange();
      r.collapse(backwards);
    }
    t = r.startContainer;
    if (t.nodeType === 1) {
      t = t.childNodes[r.startOffset];
    }
    let o = t;
    while (o && (o.nodeType !== 1)) {
      o = o.previousSibling;
    }
    t = o || (t != null ? t.parentNode : undefined);
    return t;
  },

  getSelectionFocusElement() {
    const sel = globalThis.getSelection();
    let node = sel.focusNode;
    if ((node == null)) {
      return null;
    }
    if ((node === sel.anchorNode) && (sel.focusOffset === sel.anchorOffset)) {
      // If the selection is not a caret inside a `#text`, which has no child nodes, then it either
      // *is* an element, or is inside an opaque element (eg. <input>).
      node = node.childNodes[sel.focusOffset] || node;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return node.parentElement;
    } else {
      return node;
    }
  },

  // Get the element in the DOM hierachy that contains `element`.
  // If the element is rendered in a shadow DOM via a <content> element, the <content> element will
  // be returned, so the shadow DOM is traversed rather than passed over.
  getContainingElement(element) {
    return (typeof element.getDestinationInsertionPoints === "function"
      ? element.getDestinationInsertionPoints()[0]
      : undefined) || element.parentElement;
  },

  // This tests whether a window is too small to be useful.
  windowIsTooSmall() {
    return (globalThis.innerWidth < 3) || (globalThis.innerHeight < 3);
  },

  // Inject the user's Vimium CSS styles onto the page. This is only necessary for our
  // chrome-extension:// pages and frames.
  // - parent: The node to append the style tag to. Optional.
  injectUserCss(parent) {
    const style = document.createElement("style");
    style.type = "text/css";
    style.textContent = Settings.get("userDefinedLinkHintCss");
    parent = parent ?? document.head;
    parent.appendChild(style);
  },
};


  // Commands for manipulating rects.
const Rect = {
  // Create a rect given the top left and bottom right corners.
  create(x1, y1, x2, y2) {
    return {
      bottom: y2,
      top: y1,
      left: x1,
      right: x2,
      width: x2 - x1,
      height: y2 - y1,
    };
  },

  copy(rect) {
    return {
      bottom: rect.bottom,
      top: rect.top,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
    };
  },

  // Translate a rect by x horizontally and y vertically.
  translate(rect, x, y) {
    if (x == null) {
      x = 0;
    }
    if (y == null) {
      y = 0;
    }
    return {
      bottom: rect.bottom + y,
      top: rect.top + y,
      left: rect.left + x,
      right: rect.right + x,
      width: rect.width,
      height: rect.height,
    };
  },

  // Subtract rect2 from rect1, returning an array of rects which are in rect1 but not rect2.
  subtract(rect1, rect2) {
    // Bound rect2 by rect1
    rect2 = this.create(
      Math.max(rect1.left, rect2.left),
      Math.max(rect1.top, rect2.top),
      Math.min(rect1.right, rect2.right),
      Math.min(rect1.bottom, rect2.bottom),
    );

    // If bounding rect2 has made the width or height negative, rect1 does not contain rect2.
    if ((rect2.width < 0) || (rect2.height < 0)) {
      return [Rect.copy(rect1)];
    }

    //
    // All the possible rects, in the order
    // +-+-+-+
    // |1|2|3|
    // +-+-+-+
    // |4| |5|
    // +-+-+-+
    // |6|7|8|
    // +-+-+-+
    // where the outer rectangle is rect1 and the inner rectangle is rect 2. Note that the rects may
    // be of width or height 0.
    //
    const rects = [
      // Top row.
      this.create(rect1.left, rect1.top, rect2.left, rect2.top),
      this.create(rect2.left, rect1.top, rect2.right, rect2.top),
      this.create(rect2.right, rect1.top, rect1.right, rect2.top),
      // Middle row.
      this.create(rect1.left, rect2.top, rect2.left, rect2.bottom),
      this.create(rect2.right, rect2.top, rect1.right, rect2.bottom),
      // Bottom row.
      this.create(rect1.left, rect2.bottom, rect2.left, rect1.bottom),
      this.create(rect2.left, rect2.bottom, rect2.right, rect1.bottom),
      this.create(rect2.right, rect2.bottom, rect1.right, rect1.bottom),
    ];

    return rects.filter((rect) => (rect.height > 0) && (rect.width > 0));
  },

  // Determine whether two rects overlap.
  intersects(rect1, rect2) {
    return (rect1.right > rect2.left) &&
      (rect1.left < rect2.right) &&
      (rect1.bottom > rect2.top) &&
      (rect1.top < rect2.bottom);
  },

  // Determine whether two rects overlap, including 0-width intersections at borders.
  intersectsStrict(rect1, rect2) {
    return (rect1.right >= rect2.left) && (rect1.left <= rect2.right) &&
      (rect1.bottom >= rect2.top) && (rect1.top <= rect2.bottom);
  },

  equals(rect1, rect2) {
    for (const property of ["top", "bottom", "left", "right", "width", "height"]) {
      if (rect1[property] !== rect2[property]) {
        return false;
      }
    }
    return true;
  },

  intersect(rect1, rect2) {
    return this.create(
      Math.max(rect1.left, rect2.left),
      Math.max(rect1.top, rect2.top),
      Math.min(rect1.right, rect2.right),
      Math.min(rect1.bottom, rect2.bottom),
    );
  },
};


  class HandlerStack {
  constructor() {
    this.debug = false;
    this.eventNumber = 0;
    this.stack = [];
    this.counter = 0;

    // A handler should return this value to immediately discontinue bubbling and pass the event on
    // to the underlying page.
    this.passEventToPage = new Object();

    // A handler should return this value to indicate that the event has been consumed, and no
    // further processing should take place. The event does not propagate to the underlying page.
    this.suppressPropagation = new Object();

    // A handler should return this value to indicate that bubbling should be restarted. Typically,
    // this is used when, while bubbling an event, a new mode is pushed onto the stack.
    this.restartBubbling = new Object();

    // A handler should return this value to continue bubbling the event.
    this.continueBubbling = true;

    // A handler should return this value to suppress an event.
    this.suppressEvent = false;
  }

  // Adds a handler to the top of the stack. Returns a unique ID for that handler that can be used
  // to remove it later.
  push(handler) {
    handler.id = ++this.counter;
    if (!handler._name) {
      handler._name = `anon-${handler.id}`;
    }
    this.stack.push(handler);
    return handler.id = ++this.counter;
  }

  // As above, except the new handler is added to the bottom of the stack.
  unshift(handler) {
    handler.id = ++this.counter;
    if (!handler._name) {
      handler._name = `anon-${handler.id}`;
    }
    handler._name += "/unshift";
    this.stack.unshift(handler);
    return handler.id = ++this.counter;
  }

  // Called whenever we receive a key or other event. Each individual handler has the option to stop
  // the event's propagation by returning a falsy value, or stop bubbling by
  // returning @suppressPropagation or
  // @passEventToPage.
  bubbleEvent(type, event) {
    this.eventNumber += 1;
    const eventNumber = this.eventNumber;
    for (const handler of this.stack.slice().reverse()) {
      // A handler might have been removed (handler.id == null), so check; or there might just be no
      // handler for this type of event.
      if (!(handler != null ? handler.id : undefined) || !handler[type]) {
        if (this.debug) {
          this.logResult(eventNumber, type, event, handler, `skip [${(handler[type] != null)}]`);
        }
      } else {
        this.currentId = handler.id;
        const result = handler[type].call(this, event);
        if (this.debug) {
          this.logResult(eventNumber, type, event, handler, result);
        }
        if (result === this.passEventToPage) {
          return true;
        } else if (result === this.suppressPropagation) {
          if (type === "keydown") {
            DomUtils.consumeKeyup(event, null, true);
          } else {
            DomUtils.suppressPropagation(event);
          }
          return false;
        } else if (result === this.restartBubbling) {
          return this.bubbleEvent(type, event);
        } else if (
          (result === this.continueBubbling) || (result && (result !== this.suppressEvent))
        ) {
          true; // Do nothing, but continue bubbling.
        } else {
          // result is @suppressEvent or falsy.
          if (this.isChromeEvent(event)) {
            if (type === "keydown") {
              DomUtils.consumeKeyup(event);
            } else {
              DomUtils.suppressEvent(event);
            }
          }
          return false;
        }
      }
    }

    // None of our handlers care about this event, so pass it to the page.
    return true;
  }

  remove(id) {
    if (id == null) {
      id = this.currentId;
    }
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const handler = this.stack[i];
      if (handler.id === id) {
        // Mark the handler as removed.
        handler.id = null;
        this.stack.splice(i, 1);
        break;
      }
    }
  }

  // The handler stack handles chrome events (which may need to be suppressed) and internal (pseudo)
  // events. This checks whether the event at hand is a chrome event.
  isChromeEvent(event) {
    // TODO(philc): Shorten this.
    return ((event != null ? event.preventDefault : undefined) != null) ||
      ((event != null ? event.stopImmediatePropagation : undefined) != null);
  }

  // Convenience wrappers. Handlers must return an approriate value. These are wrappers which
  // handlers can use to always return the same value. This then means that the handler itself can
  // be implemented without regard to its return value.
  alwaysContinueBubbling(handler = null) {
    if (typeof handler === "function") {
      handler();
    }
    return this.continueBubbling;
  }

  alwaysSuppressPropagation(handler = null) {
    // TODO(philc): Shorten this.
    if ((typeof handler === "function" ? handler() : undefined) === this.suppressEvent) {
      return this.suppressEvent;
    } else {
      return this.suppressPropagation;
    }
  }

  // Debugging.
  logResult(eventNumber, type, event, handler, result) {
    if ((event != null ? event.type : undefined) === "keydown") { // Tweak this as needed.
      let label = (() => {
        switch (result) {
          case this.passEventToPage:
            return "passEventToPage";
          case this.suppressEvent:
            return "suppressEvent";
          case this.suppressPropagation:
            return "suppressPropagation";
          case this.restartBubbling:
            return "restartBubbling";
          case "skip":
            return "skip";
          case true:
            return "continue";
        }
      })();
      if (!label) {
        label = result ? "continue/truthy" : "suppress";
      }
      console.log(`${eventNumber}`, type, handler._name, label);
    }
  }

  show() {
    console.log(`${this.eventNumber}:`);
    for (const handler of this.stack.slice().reverse()) {
      console.log("  ", handler._name);
    }
  }

  // For tests only.
  reset() {
    this.stack = [];
  }
}

const handlerStack = new HandlerStack();
  // The possible destinations for new tabs opened using Vimium's `createTab` command.
const newTabDestinations = {
  browserNewTabPage: "browserNewTabPage",
  vimiumNewTabPage: "vimiumNewTabPage",
  customUrl: "customUrl",
};

const vimiumNewTabPageUrl = "https://vimium.github.io/new-tab/";

const defaultOptions = {
  scrollStepSize: 60,
  smoothScroll: true,
  keyMappings: "# Insert your preferred key mappings here.",
  linkHintCharacters: "sadfjklewcmpgh",
  linkHintNumbers: "0123456789",
  filterLinkHints: false,
  hideHud: false,
  hideUpdateNotifications: false,
  userDefinedLinkHintCss: `\
div > .vimiumHintMarker {
/* linkhint boxes */
background: -webkit-gradient(linear, left top, left bottom, color-stop(0%,#FFF785),
  color-stop(100%,#FFC542));
border: 1px solid #E3BE23;
}

div > .vimiumHintMarker span {
/* linkhint text */
color: black;
font-weight: bold;
font-size: 12px;
}

div > .vimiumHintMarker > .matchingCharacter {
}\
`,
  // Default exclusion rules.
  exclusionRules: [],

  // NOTE: If a page contains both a single angle-bracket link and a double angle-bracket link,
  // then in most cases the single bracket link will be "prev/next page" and the double bracket
  // link will be "first/last page", so we put the single bracket first in the pattern string so
  // that it gets searched for first.

  // "\bprev\b,\bprevious\b,\bback\b,<,‹,←,«,≪,<<"
  previousPatterns: "prev,previous,back,older,<,\u2039,\u2190,\xab,\u226a,<<",
  // "\bnext\b,\bmore\b,>,›,→,»,≫,>>"
  nextPatterns: "next,more,newer,>,\u203a,\u2192,\xbb,\u226b,>>",
  // default/fall back search engine
  searchUrl: "https://www.google.com/search?q=",
  // put in an example search engine
  searchEngines: `\
w: https://www.wikipedia.org/w/index.php?title=Special:Search&search=%s Wikipedia

# More examples.
#
# (Vimium supports search completion Wikipedia, as
# above, and for these.)
#
# g: https://www.google.com/search?q=%s Google
# l: https://www.google.com/search?q=%s&btnI I'm feeling lucky...
# y: https://www.youtube.com/results?search_query=%s Youtube
# gm: https://www.google.com/maps?q=%s Google maps
# b: https://www.bing.com/search?q=%s Bing
# d: https://duckduckgo.com/?q=%s DuckDuckGo
# az: https://www.amazon.com/s/?field-keywords=%s
# qw: https://www.qwant.com/?q=%s Qwant\
`,
  newTabDestination: newTabDestinations.vimiumNewTabPage,
  newTabCustomUrl: "",
  openVomnibarOnNewTabPage: true,
  grabBackFocus: true,
  regexFindMode: false,
  waitForEnterForFilteredHints: true,
  helpDialog_showAdvancedCommands: false,
  ignoreKeyboardLayout: false,
};

/*
 * This class fetches and exposes the view over Vimium's settings data, which is stored in
 * chrome.storage. It merges the user's customizations into the default setting values.
 * It dispatches the "change" event when the settings have been changed.
 */
const Settings = {
  _settings: null,
  _chromeStorageListenerInstalled: false,

  defaultOptions,
  newTabDestinations,
  vimiumNewTabPageUrl,

  async onLoaded() {
    if (!this.isLoaded()) {
      await this.load();
    }
  },

  async chromeStorageOnChanged(_changes, area) {
    // We store data with keys [settings-v1, ...] into the local storage. Only broadcast an event if
    // the object stored with the settings key has changed.
    // We only store settings in the sync area, so storage.sync changes must be settings changes.
    if (area == "sync") {
      await this.load();
      this.dispatchEvent("change");
    }
  },

  async load() {
    // NOTE(philc): If we change the schema of the settings object in a backwards-incompatible way,
    // then we can fetch the whole storage object here and migrate any old settings the user has to
    // the new schema.
    if (!this._chromeStorageListenerInstalled) {
      this._chromeStorageListenerInstalled = true;
      chrome.storage.onChanged.addListener((changes, area) =>
        this.chromeStorageOnChanged(changes, area)
      );
    }

    let result = await chrome.storage.sync.get(null); // Get every key.
    result = this.migrateSettingsIfNecessary(result);
    result["settingsVersion"] = Utils.getCurrentVersion();
    this._settings = Object.assign(globalThis.structuredClone(defaultOptions), result);
  },

  isLoaded() {
    return this._settings != null;
  },

  get(key) {
    if (!this.isLoaded()) {
      throw new Error(`Getting the setting ${key} before settings have been loaded.`);
    }
    return globalThis.structuredClone(this._settings[key]);
  },

  async set(key, value) {
    if (!this.isLoaded()) {
      throw new Error(`Writing the setting ${key} before settings have been loaded.`);
    }
    this._settings[key] = value;
    await this.setSettings(this._settings);
  },

  getSettings() {
    return globalThis.structuredClone(this._settings);
  },

  migratePre2_0(settings) {
    // Prior to Vimium version 2.0.0:
    // - In chrome.storages.sync, the value of each setting was encoded as a JSON string using
    //   JSON.stringify. This was probably an artifact of originally using localStorage, but is no
    //   longer necessary now that chrome.storage exists and can store objects. Note that when
    //   exporting a backup of settings on the options page, the values were not encoded as JSON
    //   strings.
    // - We only stored the settingsVersion key in the JSON payload when a user exported a backup of
    //   their settings. It wasn't set when writing the settings to chrome.storage.sync.

    // NOTE(philc): We want to migrate settings which have JSON-encoded values. Based on the notes
    // above, that should mean we only need to migrate if the settings object is missing a
    // "settingsVersion" key.
    const shouldMigrate = settings["settingsVersion"] == null;
    if (!shouldMigrate) {
      return settings;
    }

    // Migration for v2.0.0: decode all values so that they're not JSON string encoded.
    const newSettings = {};
    for (const [k, v] of Object.entries(settings)) {
      // Most pre-2.0 settings were strings, but the global marks were stored as native values. See
      // #4323. So check the setting value's type before migrating.
      if (typeof v === "string") {
        newSettings[k] = JSON.parse(v);
      } else {
        newSettings[k] = v;
      }
    }
    // This key is no longer stored in our settings, but rather chrome.storage.session.
    delete newSettings.passNextKeyKeys;
    return newSettings;
  },

  migratePre2_4(settings) {
    const version = settings["settingsVersion"];
    // In 2.4 we added some new settings which control the URL that new tabs are opened in.
    const shouldMigrate = version && (Utils.compareVersions(version, "2.4") < 0);
    if (!shouldMigrate) {
      return settings;
    }
    const previousDefaultNewTabUrl = "about:newtab";
    if (!settings.newTabUrl || settings.newTabUrl == previousDefaultNewTabUrl) {
      // newTabUrl was absent (user never changed from the default, so it was pruned from storage)
      // or was explicitly set to the browser's default new tab URL.
      settings.newTabDestination = newTabDestinations.browserNewTabPage;
    } else if (settings.newTabUrl == "pages/blank.html") {
      // This was meant to be used as a blank page, but we no longer include this page in Vimium.
      // We use "vimium.github.io/new-tab/" instead.
      settings.newTabDestination = newTabDestinations.vimiumNewTabPage;
    } else if (settings.newTabUrl) {
      // It's some other custom URL the user has set.
      settings.newTabDestination = newTabDestinations.customUrl;
      settings.newTabCustomUrl = settings.newTabUrl;
    }
    delete settings.newTabUrl;
    return settings;
  },

  migratePre2_4_1(settings) {
    // In migratePre2_4, there was a bug: pre-2.4 users who had never changed their newTabUrl (which
    // defaulted to "about:newtab") were incorrectly given newTabDestination = "vimiumNewTabPage".
    // Fix this by setting newTabDestination = "browserNewTabPage" for any 2.4.0 user who hasn't set
    // their newTabDestination to something other than "vimiumNewTabPage" (the default value).
    const version = settings["settingsVersion"];
    // Only run this for users that went through the buggy 2.4.0 migration (version >= "2.4" but <
    // "2.4.1"). Users upgrading directly from pre-2.4 are handled correctly by the (since
    // corrected) migratePre2_4 and should not have this fixup applied.
    const shouldMigrate = version &&
      (Utils.compareVersions(version, "2.4") >= 0) &&
      (Utils.compareVersions(version, "2.4.1") < 0);
    if (!shouldMigrate) {
      return settings;
    }
    const dest = settings.newTabDestination;
    if (!dest || dest == newTabDestinations.vimiumNewTabPage) {
      settings.newTabDestination = newTabDestinations.browserNewTabPage;
    }
    return settings;
  },

  // Returns a settings object and performs any migrations required if the settings object is from
  // an older version of Vimium.
  migrateSettingsIfNecessary(settings) {
    settings = this.migratePre2_0(settings);
    settings = this.migratePre2_4(settings);
    settings = this.migratePre2_4_1(settings);
    return settings;
  },

  async setSettings(settings) {
    settings = this.migrateSettingsIfNecessary(settings);
    settings["settingsVersion"] = Utils.getCurrentVersion();
    const result = this.pruneOutDefaultValues(settings);
    // If, after pruning, some keys were removed because their values are now equal to the default
    // values, then explicitly clear those from storage. Otherwise they will remain.
    // NOTE(philc): This kind of sharp edge is a reason to switch to storing the settings object as
    // one big object, rather than as top-level keys in chrome.storage. The tradeoff is that each
    // value in chrome-storage has a maximum size.
    const resultKeys = Object.keys(result);
    const removedKeys = Object.keys(settings).filter((key) => !resultKeys.includes(key));
    await chrome.storage.sync.remove(removedKeys);
    await chrome.storage.sync.set(result);
    await this.load();
  },

  // Returns a new object, removing the keys from `settings` which are equal to the default values
  // for those keys.
  pruneOutDefaultValues(settings) {
    const clonedSettings = globalThis.structuredClone(settings);
    for (const [k, v] of Object.entries(settings)) {
      if (JSON.stringify(v) == JSON.stringify(defaultOptions[k])) {
        delete clonedSettings[k];
      }
    }
    return clonedSettings;
  },

  // Used only by tests.
  async clear() {
    this._settings = null;
    await chrome.storage.sync.clear();
  },
};

Object.assign(Settings, EventDispatcher);


  // This // implements find-mode query history as a list of raw queries, most recent first.
// This is under lib/ since it is used by both content scripts and iframes from pages/.
const FindModeHistory = {
  storage: chrome.storage.session,
  key: "findModeRawQueryList",
  max: 50,
  rawQueryList: null,

  async init() {
    this.isIncognitoMode = chrome.extension.inIncognitoContext;

    if (!this.rawQueryList) {
      if (this.isIncognitoMode) {
        this.key = "findModeRawQueryListIncognito";
      }

      let result = await this.storage.get(this.key);
      if (this.isIncognitoMode) {
        // This is the first incognito tab, so we need to initialize the incognito-mode query
        // history.
        result = await this.storage.get("findModeRawQueryList");
        this.rawQueryList = result.findModeRawQueryList || [];
        this.storage.set({ findModeRawQueryListIncognito: this.rawQueryList });
      } else {
        this.rawQueryList = result[this.key] || [];
      }
    }

    chrome.storage.onChanged.addListener((changes, _area) => {
      if (changes[this.key]) {
        this.rawQueryList = changes[this.key].newValue;
      }
    });
  },

  getQuery(index) {
    if (index == null) {
      index = 0;
    }
    return this.rawQueryList[index] || "";
  },

  async saveQuery(query) {
    if (query.length == 0) {
      return;
    }
    this.rawQueryList = this.refreshRawQueryList(query, this.rawQueryList);
    const newSetting = {};
    newSetting[this.key] = this.rawQueryList;
    await this.storage.set(newSetting);
    // If there are any active incognito-mode tabs, then propagate this query to those tabs too.
    if (!this.isIncognitoMode) {
      const result = await this.storage.get("findModeRawQueryListIncognito");
      if (result.findModeRawQueryListIncognito) {
        await this.storage.set({
          findModeRawQueryListIncognito: this.refreshRawQueryList(
            query,
            result.findModeRawQueryListIncognito,
          ),
        });
      }
    }
  },

  refreshRawQueryList(query, rawQueryList) {
    return ([query].concat(rawQueryList.filter((q) => q !== query))).slice(0, this.max + 1);
  },
};


  // This is the order they will be shown in the help dialog.
//
// Properties:
// - advanced: advanced commands are not shown in the help dialog by default.
// - background: whether this command has to be run by the background page.
// - desc: shown in the help dialog and command listing page.
// - details: extra help information that will only be shown on the command listing page.
// - group: commands are displayed in groups in the help dialog and command listing.
// - noRepeat: whether this command can be used with a count key prefix.
// - repeatLimit: the number of allowed repetitions of this command before the user is prompted for
//   confirmation.
// - topFrame: whether this command must be run only in the top frame of a page.
//
const allCommands = { list: [
  //
  // Navigation
  //

  {
    name: "scrollDown",
    desc: "Scroll down",
    group: "navigation",
  },

  {
    name: "scrollUp",
    desc: "Scroll up",
    group: "navigation",
  },

  {
    name: "scrollToTop",
    desc: "Scroll to the top of the page",
    group: "navigation",
    noRepeat: true,
  },

  {
    name: "scrollToBottom",
    desc: "Scroll to the bottom of the page",
    group: "navigation",
    noRepeat: true,
  },

  {
    name: "scrollPageDown",
    desc: "Scroll a half page down",
    group: "navigation",
  },

  {
    name: "scrollPageUp",
    desc: "Scroll a half page up",
    group: "navigation",
  },

  {
    name: "scrollFullPageDown",
    desc: "Scroll a full page down",
    group: "navigation",
  },

  {
    name: "scrollFullPageUp",
    desc: "Scroll a full page up",
    group: "navigation",
  },

  {
    name: "scrollLeft",
    desc: "Scroll left",
    group: "navigation",
  },

  {
    name: "scrollRight",
    desc: "Scroll right",
    group: "navigation",
    advanced: true,
  },

  {
    name: "scrollToLeft",
    desc: "Scroll all the way to the left",
    group: "navigation",
    advanced: true,
    noRepeat: true,
  },

  {
    name: "scrollToRight",
    desc: "Scroll all the way to the right",
    group: "navigation",
    advanced: true,
    noRepeat: true,
  },

  {
    name: "reload",
    desc: "Reload the page",
    group: "navigation",
    background: true,
    options: {
      hard: "Perform a hard reload, forcing the browser to bypass its cache.",
    },
    noRepeat: true,
  },

  {
    name: "copyCurrentUrl",
    desc: "Copy the current URL to the clipboard",
    group: "navigation",
    noRepeat: true,
  },

  {
    name: "openCopiedUrlInCurrentTab",
    desc: "Open the clipboard's URL in the current tab",
    group: "navigation",
    noRepeat: true,
  },

  {
    name: "openCopiedUrlInNewTab",
    desc: "Open the clipboard's URL in a new tab",
    group: "navigation",
    noRepeat: true,
    options: {
      position: "Where to place the tab in the tab bar. " +
        "One of `start`, `before`, `after`, `end`. `after` is the default.",
    },
  },

  {
    name: "goUp",
    desc: "Go up the URL hierarchy",
    group: "navigation",
    advanced: true,
  },

  {
    name: "goToRoot",
    desc: "Go to the root of current URL hierarchy",
    group: "navigation",
    advanced: true,
    noRepeat: true,
  },

  {
    name: "enterInsertMode",
    desc: "Enter insert mode",
    group: "navigation",
    noRepeat: true,
  },

  {
    name: "enterVisualMode",
    desc: "Enter visual mode",
    group: "navigation",
    noRepeat: true,
  },

  {
    name: "enterVisualLineMode",
    desc: "Enter visual line mode",
    group: "navigation",
    advanced: true,
    noRepeat: true,
  },

  {
    name: "passNextKey",
    desc: "Pass the next key to the page",
    options: {
      normal: "Optional. Enter Vimium's normal mode, and ignore any defined pass keys.",
    },
    group: "navigation",
    advanced: true,
  },

  {
    name: "focusInput",
    desc: "Focus the first text input on the page",
    group: "navigation",
    noRepeat: true,
  },

  {
    name: "LinkHints.activateMode",
    desc: "Open a link in the current tab",
    options: {
      action: "one of `hover`, `focus`, `copy-text`. When a link is selected, " +
        "instead of clicking on the link, perform the specified action.",
    },
    group: "navigation",
    advanced: true,
  },

  {
    name: "LinkHints.activateModeToOpenInNewTab",
    desc: "Open a link in a new tab",
    group: "navigation",
  },

  {
    name: "LinkHints.activateModeToOpenInNewForegroundTab",
    desc: "Open a link in a new tab & switch to it",
    group: "navigation",
  },

  {
    name: "LinkHints.activateModeWithQueue",
    desc: "Open multiple links in a new tab",
    group: "navigation",
    advanced: true,
    noRepeat: true,
  },

  {
    name: "LinkHints.activateModeToDownloadLink",
    desc: "Download link url",
    group: "navigation",
    advanced: true,
  },

  {
    name: "LinkHints.activateModeToOpenIncognito",
    desc: "Open a link in incognito window",
    group: "navigation",
    advanced: true,
  },

  {
    name: "LinkHints.activateModeToCopyLinkUrl",
    desc: "Copy a link URL to the clipboard",
    group: "navigation",
    advanced: true,
  },

  {
    name: "goPrevious",
    desc: "Follow the link labeled previous or <",
    group: "navigation",
    advanced: true,
    noRepeat: true,
  },

  {
    name: "goNext",
    desc: "Follow the link labeled next or >",
    group: "navigation",
    advanced: true,
    noRepeat: true,
  },

  {
    name: "nextFrame",
    desc: "Select the next frame on the page",
    group: "navigation",
    background: true,
  },

  {
    name: "mainFrame",
    desc: "Select the page's main/top frame",
    group: "navigation",
    topFrame: true,
    noRepeat: true,
  },

  {
    name: "Marks.activateCreateMode",
    desc: "Create a new mark",
    details: "Do this by typing the key bound to this command, and then a letter. " +
      "This will set a mark bound to that letter. Lowercase letters are local marks and uppercase " +
      "letters are global marks.",
    options: {
      swap: "Swap global and local marks. This option exists because in a browser, global marks " +
        "are generally more useful than local marks, and so it may be desirable to make lowercase " +
        "letters represent global marks rather than local marks.",
    },
    group: "navigation",
    advanced: true,
    noRepeat: true,
  },

  {
    name: "Marks.activateGotoMode",
    desc: "Jump to a mark",
    options: {
      swap: "Swap global and local marks. This option exists because in a browser, global marks " +
        "are generally more useful than local marks, and so it may be desirable to make lowercase " +
        "letters represent global marks rather than local marks.",
    },
    group: "navigation",
    advanced: true,
    noRepeat: true,
  },

  //
  // Vomnibar
  //

  {
    name: "Vomnibar.activate",
    desc: "Open URL, bookmark or history entry",
    options: {
      query: "The text to prefill the Vomnibar with.",
      keyword: 'The keyword of a search engine defined in the "Custom search engines" ' +
        "section of the Vimium Options page. The Vomnibar will be scoped to use that search engine.",
    },
    group: "vomnibar",
    topFrame: true,
    noRepeat: true,
  },

  {
    name: "Vomnibar.activateInNewTab",
    desc: "Open URL, bookmark or history entry in a new tab",
    group: "vomnibar",
    options: {
      query: "The text to prefill the Vomnibar with.",
      keyword: 'The keyword of a search engine defined in the "Custom search engines" ' +
        "section of the Vimium Options page. The Vomnibar will be scoped to use that search engine.",
    },
    topFrame: true,
    noRepeat: true,
  },

  {
    name: "Vomnibar.activateBookmarks",
    desc: "Open a bookmark",
    group: "vomnibar",
    options: {
      query: "The text to prefill the Vomnibar with.",
    },
    topFrame: true,
    noRepeat: true,
  },

  {
    name: "Vomnibar.activateBookmarksInNewTab",
    desc: "Open a bookmark in a new tab",
    group: "vomnibar",
    options: {
      query: "The text to prefill the Vomnibar with.",
    },
    topFrame: true,
    noRepeat: true,
  },

  {
    name: "Vomnibar.activateTabSelection",
    desc: "Search through your open tabs",
    group: "vomnibar",
    topFrame: true,
    noRepeat: true,
  },

  {
    name: "Vomnibar.activateEditUrl",
    desc: "Edit the current URL",
    group: "vomnibar",
    topFrame: true,
    noRepeat: true,
  },

  {
    name: "Vomnibar.activateEditUrlInNewTab",
    desc: "Edit the current URL and open in a new tab",
    group: "vomnibar",
    topFrame: true,
    noRepeat: true,
  },

  {
    name: "Vomnibar.activateCommandSelection",
    desc: "Execute a Vimium command",
    group: "vomnibar",
    topFrame: true,
    noRepeat: true,
  },

  //
  // Find
  //

  {
    name: "enterFindMode",
    desc: "Enter find mode.",
    group: "find",
    noRepeat: true,
  },

  {
    name: "performFind",
    desc: "Cycle forward to the next find match",
    group: "find",
  },

  {
    name: "performBackwardsFind",
    desc: "Cycle backward to the previous find match",
    group: "find",
  },

  {
    name: "findSelected",
    desc: "Find the selected text",
    group: "find",
    advanced: true,
  },

  {
    name: "findSelectedBackwards",
    desc: "Find the selected text, searching backwards",
    group: "find",
    advanced: true,
  },

  //
  // History
  //

  {
    name: "goBack",
    desc: "Go back in history",
    group: "history",
  },

  {
    name: "goForward",
    desc: "Go forward in history",
    group: "history",
  },

  //
  // Tabs
  //

  {
    name: "createTab",
    desc: "Create new tab",
    options: {
      "(any url)": "Open this URL, rather than the browser's new tab page. " +
        "E.g.: `map X createTab https://example.com`",
      window: "Create the tab in a new window",
      incognito: "Create the tab in an incognito window",
      position: "Where to place the tab in the tab bar. " +
        "One of `start`, `before`, `after`, `end`. `after` is the default.",
    },
    group: "tabs",
    background: true,
    repeatLimit: 20,
  },

  {
    name: "previousTab",
    desc: "Go one tab left",
    group: "tabs",
    background: true,
  },

  {
    name: "nextTab",
    desc: "Go one tab right",
    group: "tabs",
    background: true,
  },

  {
    name: "visitPreviousTab",
    desc: "Go to previously-visited tab",
    group: "tabs",
    background: true,
  },

  {
    name: "firstTab",
    desc: "Go to the first tab",
    group: "tabs",
    background: true,
    noRepeat: true,
  },

  {
    name: "lastTab",
    desc: "Go to the last tab",
    group: "tabs",
    background: true,
    noRepeat: true,
  },

  {
    name: "duplicateTab",
    desc: "Duplicate current tab",
    group: "tabs",
    background: true,
    repeatLimit: 20,
  },

  {
    name: "togglePinTab",
    desc: "Pin or unpin current tab",
    group: "tabs",
    background: true,
    noRepeat: true,
  },

  {
    name: "toggleMuteTab",
    desc: "Mute or unmute current tab",
    options: {
      all: "Mute all tabs.",
      other: "Mute every tab except the current one.",
    },
    group: "tabs",
    background: true,
    noRepeat: true,
  },

  {
    name: "removeTab",
    desc: "Close current tab",
    group: "tabs",
    background: true,
    // Don't close (in one command invocation) more than the number of tabs that can be re-opened by
    // the browser.
    // `chrome` is undefined when the e2e test harness imports this file, outside of the extension.
    repeatLimit: globalThis.chrome?.sessions?.MAX_SESSION_RESULTS || 25,
  },

  {
    name: "restoreTab",
    desc: "Restore closed tab",
    group: "tabs",
    background: true,
    repeatLimit: 20,
  },

  {
    name: "moveTabToNewWindow",
    desc: "Move tab to new window",
    group: "tabs",
    advanced: true,
    background: true,
    noRepeat: true,
  },

  {
    name: "closeTabsOnLeft",
    desc: "Close tabs on the left",
    group: "tabs",
    advanced: true,
    background: true,
  },

  {
    name: "closeTabsOnRight",
    desc: "Close tabs on the right",
    group: "tabs",
    advanced: true,
    background: true,
  },

  {
    name: "closeOtherTabs",
    desc: "Close all other tabs",
    group: "tabs",
    advanced: true,
    background: true,
    noRepeat: true,
  },

  {
    name: "moveTabLeft",
    desc: "Move tab to the left",
    group: "tabs",
    advanced: true,
    background: true,
  },

  {
    name: "moveTabRight",
    desc: "Move tab to the right",
    group: "tabs",
    advanced: true,
    background: true,
  },

  {
    name: "setZoom",
    desc: "Set zoom",
    group: "tabs",
    advanced: true,
    background: true,
    options: {
      level: "The zoom level. This can be a range of [0.25, 5.0]. 1.0 is the default.",
    },
    noRepeat: true,
  },

  {
    name: "zoomIn",
    desc: "Zoom in",
    group: "tabs",
    advanced: true,
    background: true,
  },

  {
    name: "zoomOut",
    desc: "Zoom out",
    group: "tabs",
    advanced: true,
    background: true,
  },

  {
    name: "zoomReset",
    desc: "Reset zoom",
    group: "tabs",
    advanced: true,
    background: true,
    noRepeat: true,
  },

  //
  // Misc
  //

  {
    name: "toggleViewSource",
    desc: "View page source",
    group: "misc",
    advanced: true,
    noRepeat: true,
  },

  {
    name: "showHelp",
    desc: "Show help",
    group: "misc",
    noRepeat: true,
    topFrame: true,
  },
] };
  
// A specification for a command that's currently bound to a key sequence, as defined by the default
// key bindings, or as it appears in the user's keymapping settings.
class RegistryEntry {
  // Array of keys.
  keySequence;
  // Name of the command.
  command;
  // Whether this command can be used with a count key prefix.
  noRepeat;
  // The number of allowed repetitions of this command before the user is prompted for confirmation.
  repeatLimit;
  // Whether this command has to be run by the background page.
  background;
  // Whether this command must be run only in the top frame of a page.
  topFrame;
  // The map of options for this command. This is a parsed, sanitized version of the user's options
  // for this command.
  options;

  constructor(o) {
    Object.seal(this);
    if (o) {
      Object.assign(this, o);
    }
  }
}

// This is intentionally a superset of valid modifiers (a, c, m, s).
const modifier = "(?:[a-zA-Z]-)";
const namedKey = "(?:[a-z][a-z0-9]+)"; // E.g. "left" or "f12" (always two characters or more).
const modifiedKey = `(?:${modifier}+(?:.|${namedKey}))`; // E.g. "c-*" or "c-left".
const specialKeyRegexp = new RegExp(`^<(${namedKey}|${modifiedKey})>(.*)`, "i");

// Remove comments and leading/trailing whitespace from a list of lines, and merge lines where the
// last character on the preceding line is "\".
function parseLines(text) {
  return text.replace(/\\\n/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => (line.length > 0) && !(Array.from('#"').includes(line[0])));
}

// Returns the index of the nth occurrence of the regexp in the string. -1 if not found.
function nthRegexIndex(str, regex, n) {
  if (!regex.global) {
    regex = new RegExp(regex.source, regex.flags + "g");
  }
  let match;
  let count = 0;
  while ((match = regex.exec(str)) !== null) {
    count++;
    if (count === n) {
      return match.index;
    }
    // Prevent infinite loop for zero-length matches.
    if (match.index === regex.lastIndex) {
      regex.lastIndex++;
    }
  }
  return -1;
}

const KeyMappingsParser = {
  // Parses the text supplied by the user in their "keyMappings" setting.
  // Returns { keyToRegistryEntry, keyToMappedKey, validationErrors }.
  parse(configText) {
    let keyToRegistryEntry = {};
    let mapKeyRegistry = {};
    let errors = [];
    const configLines = parseLines(configText);
    const commandsByName = Utils.keyBy(allCommands.list, "name");

    const validModifiers = ["a", "c", "m", "s"];
    const validateParsedKey = function (key) {
      if (!key?.match(modifiedKey)) {
        return;
      }
      // Check that the modifier is valid and not capitalized.
      const mod = key.split("-")[0].slice(1);
      if (!validModifiers.includes(mod)) {
        return `${key} has an invalid modifier; valid modifiers are ${validModifiers}`;
      }
    };
    const validateUrl = function (str) {
      try {
        new URL(str);
        return true;
      } catch {
        return false;
      }
    };

    for (const line of configLines) {
      const tokens = line.split(/\s+/);
      const action = tokens[0].toLowerCase();
      switch (action) {
        case "map": {
          if (tokens.length < 3) {
            errors.push(`"map" requires at least 2 arguments in the line: ${line}`);
            continue;
          }
          const [_, key, command] = tokens;
          let optionString;
          const optionsStart = nthRegexIndex(line, /\s+/, 3);
          if (optionsStart == -1) {
            optionString = "";
          } else {
            optionString = line.slice(optionsStart).trim();
          }
          const commandInfo = commandsByName[command];
          if (!commandInfo) {
            errors.push(`"${command}" is not a valid command in the line: ${line}`);
            continue;
          }
          const keySequence = this.parseKeySequence(key);
          const keyErrors = keySequence.map((k) => validateParsedKey(k)).filter((e) => e);
          if (keyErrors.length > 0) {
            errors = errors.concat(keyErrors);
            continue;
          }
          const options = this.parseCommandOptions(optionString);
          const allowedOptions = Object.keys(commandInfo.options || {});
          if (!commandInfo.noRepeat) {
            allowedOptions.push("count");
          }
          let hasUnknownOption = false;
          for (const option of Object.keys(options)) {
            if (allowedOptions.includes(option)) {
              continue;
            }
            if (allowedOptions.includes("(any url)")) {
              // Since this command allows for any URL as an argument, we perform some basic
              // validation to ensure the provided option string is indeed a URL.
              if (validateUrl(option)) {
                continue;
              }
              hasUnknownOption = true;
              errors.push(
                `Command ${command} does not support option ${option}. ` +
                  `Is this meant to be a valid URL?`,
              );
              break;
            } else {
              hasUnknownOption = true;
              errors.push(`Command ${command} does not support option ${option}`);
              break;
            }
          }
          if (hasUnknownOption) {
            break;
          }
          keyToRegistryEntry[key] = new RegistryEntry({
            keySequence,
            command,
            noRepeat: commandInfo.noRepeat,
            repeatLimit: commandInfo.repeatLimit,
            background: commandInfo.background,
            topFrame: commandInfo.topFrame,
            options,
          });
          break;
        }
        case "unmap": {
          if (tokens.length != 2) {
            errors.push(`Incorrect usage for unmap in the line: ${line}`);
            continue;
          }
          const key = tokens[1];
          delete keyToRegistryEntry[key];
          delete mapKeyRegistry[key];
          break;
        }
        case "unmapall": {
          keyToRegistryEntry = {};
          mapKeyRegistry = {};
          break;
        }
        case "mapkey": {
          if (tokens.length != 3) {
            errors.push(`Incorrect usage for mapKey in the line: ${line}`);
            continue;
          }
          const fromChar = this.parseKeySequence(tokens[1]);
          const toChar = this.parseKeySequence(tokens[2]);
          // NOTE(philc): I'm not sure why we enforce that the fromChar and toChar have to be
          // length one. It's been that way since this feature was introduced in 6596e30.
          const isValid = fromChar.length == toChar.length && toChar.length === 1;
          if (isValid) {
            mapKeyRegistry[fromChar[0]] = toChar[0];
          } else {
            errors.push(
              `mapkey only supports mapping keys which are single characters. Line: ${line}`,
            );
          }
          break;
        }
        default:
          errors.push(`"${action}" is not a valid config command in line: ${line}`);
      }
    }

    return {
      keyToRegistryEntry,
      keyToMappedKey: mapKeyRegistry,
      validationErrors: errors,
    };
  },

  // Lower-case the appropriate portions of named keys.
  //
  // A key name is one of three forms exemplified by <c-a> <left> or <c-f12> (prefixed normal key,
  // named key, or prefixed named key). Internally, for simplicity, we would like prefixes and key
  // names to be lowercase, though humans may prefer other forms <Left> or <C-a>.
  // On the other hand, <c-a> and <c-A> are different named keys - for one of them you have to press
  // "shift" as well.
  // We sort modifiers here to match the order used in keyboard_utils.js.
  // The return value is a sequence of keys: e.g. "<Space><c-A>b" -> ["<space>", "<c-A>", "b"].
  parseKeySequence(key) {
    if (key.length === 0) {
      return [];
      // Parse "<c-a>bcd" as "<c-a>" and "bcd".
    } else if (0 === key.search(specialKeyRegexp)) {
      const array = RegExp.$1.split("-");
      const adjustedLength = Math.max(array.length, 1);
      let modifiers = array.slice(0, adjustedLength - 1);
      let keyChar = array[adjustedLength - 1];
      if (keyChar.length !== 1) {
        keyChar = keyChar.toLowerCase();
      }
      modifiers = modifiers.map((m) => m.toLowerCase());
      modifiers.sort();
      return [
        "<" + modifiers.concat([keyChar]).join("-") + ">",
        ...this.parseKeySequence(RegExp.$2),
      ];
    } else {
      return [key[0], ...this.parseKeySequence(key.slice(1))];
    }
  },

  // Command options follow command mappings, and are of one of these forms:
  //   key=value     - a value
  //   key="value"   - a value surrounded by quotes
  //   key           - a flag
  parseCommandOptions(optionString) {
    const options = {};
    while (optionString != "") {
      // Note that option names are allowed to be letters only; no numbers.
      let match, matchedString, key, value;
      // Case: option value surrounded by quotes (key= "a b"). Spaces are allowed in the value.
      if ((match = optionString.match(/^([a-zA-Z]+)="([^"]+)"(\s+|$)/))) {
        matchedString = match[0];
        key = match[1];
        value = match[2];
      } // Case: option value not surrounded by quotes (key=value). Spaces aren't allowed.
      else if ((match = optionString.match(/^([a-zA-Z]+)=(\S+)(\s+|$)/))) {
        matchedString = match[0];
        key = match[1];
        value = match[2];
      } // Case: single option (flag), or "any URL". This correctly parses URLs because URLs cannot
      // contain unescaped equals or space characters. The key will be the option's name (or the
      // URL), and the value will be true.
      else if ((match = optionString.match(/^([^\s"]+)(\s+|$)/))) {
        matchedString = match[0];
        key = match[1];
        value = true;
      }
      // NOTE(philc): If this string doesn't match any of our option regexps, we could throw an
      // error here or use an assert. I think this might only happen in the case where there's a
      // single equals sign. For now, just add the whole string as a flag option. If the command in
      // question doesn't accept this option, then an error will get surfaced to the user.
      if (match == null) {
        console.log(`Warning: '${optionString}' isn't a valid option string.`);
        options[optionString] = true;
        break;
      }

      options[key] = value;
      optionString = optionString.slice(matchedString.length);
    }

    // We parse any `count` option immediately (to avoid having to parse it repeatedly later).
    if ("count" in options) {
      options.count = parseInt(options.count);
      if (isNaN(options.count)) {
        delete options.count;
      }
    }

    return options;
  },
};

const Commands = {
  // A map of keyString => RegistryEntry
  keyToRegistryEntry: null,
  // A map of typed key => key it's mapped to (via the `mapkey` config statement).
  mapKeyRegistry: null,

  async init() {
    await Settings.onLoaded();
    Settings.addEventListener("change", async () => {
      await this.loadKeyMappings(Settings.get("keyMappings"));
    });
    await this.loadKeyMappings(Settings.get("keyMappings"));
  },

  // Parses the user's keyMapping config text and persists the parsed key mappings into the
  // extension's storage, for use by the other parts of this extension.
  async loadKeyMappings(userKeyMappingsConfigText) {
    this.keyToRegistryEntry = {};
    this.mapKeyRegistry = {};

    const defaultKeyConfig = Object.keys(defaultKeyMappings).map((key) =>
      `map ${key} ${defaultKeyMappings[key]}`
    ).join("\n");

    const parsed = KeyMappingsParser.parse(
      defaultKeyConfig + "\n" + userKeyMappingsConfigText,
    );
    this.mapKeyRegistry = parsed.keyToMappedKey;
    this.keyToRegistryEntry = parsed.keyToRegistryEntry;

    await chrome.storage.session.set({ mapKeyRegistry: this.mapKeyRegistry });
    await this.installKeyStateMapping();
    this.prepareHelpPageData();

    // Push the key mappings from any passNextKey commands into storage so that they're's available
    // to the front end so they can be detected during insert mode. We exclude single-key mappings
    // for this command (i.e. printable keys) because we're considering that a configuration error:
    // when users press printable keys in insert mode, they expect that character to be input, not
    // to be droppped into a special Vimium mode.
    const passNextKeys = Object.entries(this.keyToRegistryEntry)
      .filter(([key, v]) => v.command == "passNextKey" && key.length > 1)
      .map(([key]) => key);
    await chrome.storage.session.set({ passNextKeyKeys: passNextKeys });
  },

  // This generates and installs a nested key-to-command mapping structure. There is an example in
  // mode_key_handler.js.
  async installKeyStateMapping() {
    const keyStateMapping = {};
    for (const keys of Object.keys(this.keyToRegistryEntry || {})) {
      const registryEntry = this.keyToRegistryEntry[keys];
      let currentMapping = keyStateMapping;
      for (let index = 0; index < registryEntry.keySequence.length; index++) {
        const key = registryEntry.keySequence[index];
        if (currentMapping[key] != null ? currentMapping[key].command : undefined) {
          // Do not overwrite existing command bindings, they take priority. NOTE(smblott) This is
          // the legacy behaviour.
          break;
        } else if (index < (registryEntry.keySequence.length - 1)) {
          currentMapping = currentMapping[key] != null
            ? currentMapping[key]
            : (currentMapping[key] = {});
        } else {
          currentMapping[key] = Object.assign({}, registryEntry);
          // We don't need these properties in the content scripts.
          for (const prop of ["keySequence"]) {
            delete currentMapping[key][prop];
          }
        }
      }
    }
    await chrome.storage.session.set({
      normalModeKeyStateMapping: keyStateMapping,
      // Inform `KeyboardUtils.isEscape()` whether `<c-[>` should be interpreted as `Escape`
      // (which it is by default).
      useVimLikeEscape: !("<c-[>" in keyStateMapping),
    });
  },

  // Build the "commandToOptionsToKeys" data structure and place it in chrome's session storage.
  // This is used by the help page and commands listing.
  prepareHelpPageData() {
    /*
      Map of commands to option sets to keys to trigger that command option set.
      Commands with no options will have the empty string options set.
      Example:
      {
        "zoomReset": {
          "": ["z0", "zz"] // No options, with two key maps, ie: `map zz zoomReset`
        },
        "setZoom": {
          "1.1": ["z1"], // `map z1 setZoom 1.1`
          "1.2": ["z2"], // `map z2 setZoom 1.2`
        }
      }
    */
    const commandToOptionsToKeys = {};
    const formatOptionString = (options) => {
      return Object.entries(options)
        .map(([k, v]) => {
          // When the value of an option is true, then it was parsed as a flag.
          if (v === true) {
            return k;
          } else {
            return `${k}=${v}`;
          }
        })
        .join(" ");
    };
    for (const key of Object.keys(this.keyToRegistryEntry || {})) {
      const registryEntry = this.keyToRegistryEntry[key];
      const optionString = formatOptionString(registryEntry.options || {});
      commandToOptionsToKeys[registryEntry.command] ||= {};
      commandToOptionsToKeys[registryEntry.command][optionString] ||= [];
      commandToOptionsToKeys[registryEntry.command][optionString].push(key);
    }
    chrome.storage.session.set({ commandToOptionsToKeys });
  },
};

const defaultKeyMappings = {
  // Navigating the current page
  "j": "scrollDown",
  "k": "scrollUp",
  "h": "scrollLeft",
  "l": "scrollRight",
  "gg": "scrollToTop",
  "G": "scrollToBottom",
  "zH": "scrollToLeft",
  "zL": "scrollToRight",
  "0": "scrollToLeft",
  "$": "scrollToRight",
  "<c-e>": "scrollDown",
  "<c-y>": "scrollUp",
  "d": "scrollPageDown",
  "u": "scrollPageUp",
  "r": "reload",
  "R": "reload hard",
  "yy": "copyCurrentUrl",
  "p": "openCopiedUrlInCurrentTab",
  "P": "openCopiedUrlInNewTab",
  "gi": "focusInput",
  "[[": "goPrevious",
  "]]": "goNext",
  "gf": "nextFrame",
  "gF": "mainFrame",
  "gu": "goUp",
  "gU": "goToRoot",
  "i": "enterInsertMode",
  "v": "enterVisualMode",
  "V": "enterVisualLineMode",

  // Link hints
  "f": "LinkHints.activateMode",
  "F": "LinkHints.activateModeToOpenInNewTab",
  "<a-f>": "LinkHints.activateModeWithQueue",
  "yf": "LinkHints.activateModeToCopyLinkUrl",

  // Using find
  "/": "enterFindMode",
  "n": "performFind",
  "N": "performBackwardsFind",
  "*": "findSelected",
  "#": "findSelectedBackwards",

  // Vomnibar
  "o": "Vomnibar.activate",
  "O": "Vomnibar.activateInNewTab",
  "T": "Vomnibar.activateTabSelection",
  "b": "Vomnibar.activateBookmarks",
  "B": "Vomnibar.activateBookmarksInNewTab",
  ":": "Vomnibar.activateCommandSelection",
  "ge": "Vomnibar.activateEditUrl",
  "gE": "Vomnibar.activateEditUrlInNewTab",

  // Navigating history
  "H": "goBack",
  "L": "goForward",

  // Manipulating tabs
  "K": "nextTab",
  "J": "previousTab",
  "gt": "nextTab",
  "gT": "previousTab",
  "^": "visitPreviousTab",
  "<<": "moveTabLeft",
  ">>": "moveTabRight",
  "g0": "firstTab",
  "g$": "lastTab",
  "W": "moveTabToNewWindow",
  "t": "createTab",
  "yt": "duplicateTab",
  "x": "removeTab",
  "X": "restoreTab",
  "<a-p>": "togglePinTab",
  "<a-m>": "toggleMuteTab",
  "zi": "zoomIn",
  "zo": "zoomOut",
  "z0": "zoomReset",

  // Marks
  "m": "Marks.activateCreateMode",
  "`": "Marks.activateGotoMode",

  // Misc
  "?": "showHelp",
  "gs": "toggleViewSource",
};

  //
// A mode implements a number of keyboard (and possibly other) event handlers which are pushed onto
// the handler stack when the mode is activated, and popped off when it is deactivated. The Mode
// class constructor takes a single argument "options" which can define (amongst other things):
//
// name:
//   A name for this mode.
//
// keydown:
// keypress:
// keyup:
//   Key handlers. Optional: provide these as required. The default is to continue bubbling all key
//   events.
//
// Further options are described in the constructor, below.
//
// Additional handlers associated with a mode can be added by using the push method. For example, if
// a mode responds to "focus" events, then push an additional handler:
//   @push
//     "focus": (event) => ....
// Such handlers are removed when the mode is deactivated.
//
// The following events can be handled:
//   keydown, keypress, keyup, click, focus and blur

// Debug only.
let count = 0;

class Mode {
  // This is a function rather than a constructor, becausae often subclasses need to reference
  // `this` when setting up the options argument. `this` can't be referenced in subclasses prior to
  // calling their superclass constructor.
  init(options) {
    // Constants; short, readable names for the return values expected by handlerStack.bubbleEvent,
    // used here and by subclasses.
    if (options == null) {
      options = {};
    }
    this.options = options;
    this.continueBubbling = handlerStack.continueBubbling;
    this.suppressEvent = handlerStack.suppressEvent;
    this.passEventToPage = handlerStack.passEventToPage;
    this.suppressPropagation = handlerStack.suppressPropagation;
    this.restartBubbling = handlerStack.restartBubbling;

    this.alwaysContinueBubbling = handlerStack.alwaysContinueBubbling;
    this.alwaysSuppressPropagation = handlerStack.alwaysSuppressPropagation;

    this.handlers = [];
    this.exitHandlers = [];
    this.modeIsActive = true;
    this.modeIsExiting = false;
    this.name = this.options.name || "anonymous";

    this.count = ++count;
    this.id = `${this.name}-${this.count}`;
    this.log("activate:", this.id);

    // If options.suppressAllKeyboardEvents is truthy, then all keyboard events are suppressed. This
    // avoids the need for modes which suppress all keyboard events 1) to provide handlers for all
    // of those events, or 2) to worry about event suppression and event-handler return values.
    if (this.options.suppressAllKeyboardEvents) {
      // TODO(philc): Make a let statement.
      const downHanlder = this.options["keydown"];
      this.options["keydown"] = (event) =>
        this.alwaysSuppressPropagation(() => {
          if (downHanlder) {
            return downHanlder(event);
          }
        });
      const pressHandler = this.options["keypress"];
      this.options["keypress"] = (event) =>
        this.alwaysSuppressPropagation(() => {
          if (pressHandler) {
            return pressHandler(event);
          }
        });
    }

    this.push({
      keydown: this.options.keydown || null,
      keypress: this.options.keypress || null,
      keyup: this.options.keyup || null,
      indicator: () => {
        // Update the mode indicator. Setting @options.indicator to a string shows a mode indicator
        // in the HUD. Setting @options.indicator to 'false' forces no mode indicator.
        // If @options.indicator is undefined, then the request propagates to the next mode.
        // The active indicator can also be changed with @setIndicator().
        if (this.options.indicator != null) {
          if (this.options.indicator) {
            HUD.show(this.options.indicator, undefined, this.name);
          } else {
            HUD.hide(true, false);
          }
          return this.passEventToPage;
        } else {
          return this.continueBubbling;
        }
      },
    });

    // If @options.exitOnEscape is truthy, then the mode will exit when the escape key is pressed.
    if (this.options.exitOnEscape) {
      // Note. This handler ends up above the mode's own key handlers on the handler stack, so it
      // takes priority.
      this.push({
        _name: `mode-${this.id}/exitOnEscape`,
        "keydown": (event) => {
          if (!KeyboardUtils.isEscape(event)) {
            return this.continueBubbling;
          }
          this.exit(event, event.target);
          return this.suppressEvent;
        },
      });
    }

    // If @options.exitOnBlur is truthy, then it should be an element. The mode will exit when that
    // element loses the focus.
    if (this.options.exitOnBlur) {
      this.push({
        _name: `mode-${this.id}/exitOnBlur`,
        "blur": (event) =>
          this.alwaysContinueBubbling(() => {
            if (event.target === this.options.exitOnBlur) {
              return this.exit(event);
            }
          }),
      });
    }

    // If @options.exitOnClick is truthy, then the mode will exit on any click event.
    if (this.options.exitOnClick) {
      this.push({
        _name: `mode-${this.id}/exitOnClick`,
        "click": (event) => this.alwaysContinueBubbling(() => this.exit(event)),
      });
    }

    //If @options.exitOnFocus is truthy, then the mode will exit whenever a focusable element is
    //activated.
    if (this.options.exitOnFocus) {
      this.push({
        _name: `mode-${this.id}/exitOnFocus`,
        "focus": (event) =>
          this.alwaysContinueBubbling(() => {
            if (DomUtils.isFocusable(event.target)) {
              return this.exit(event);
            }
          }),
      });
    }

    // If @options.exitOnScroll is truthy, then the mode will exit on any scroll event.
    if (this.options.exitOnScroll) {
      this.push({
        _name: `mode-${this.id}/exitOnScroll`,
        "scroll": (event) => this.alwaysContinueBubbling(() => this.exit(event)),
      });
    }

    // Some modes are singletons: there may be at most one instance active at any time. A mode is a
    // singleton if @options.singleton is set. The value of @options.singleton should be the key
    // which is intended to be unique. New instances deactivate existing instances with the same
    // key.
    if (this.options.singleton) {
      const singletons = Mode.singletons || (Mode.singletons = {});
      const key = this.options.singleton;
      this.onExit(() => delete singletons[key]);
      if (singletons[key] != null) {
        singletons[key].exit();
      }
      singletons[key] = this;
    }

    // if @options.suppressTrailingKeyEvents is set, then -- on exit -- we suppress all key events
    // until a subsquent (non-repeat) keydown or keypress. In particular, the intention is to catch
    // keyup events for keys which we have handled, but which otherwise might trigger page actions
    // (if the page is listening for keyup events).
    if (this.options.suppressTrailingKeyEvents) {
      this.onExit(function () {
        const handler = function (event) {
          if (event.repeat) {
            return handlerStack.suppressEvent;
          } else {
            this.remove();
            return handlerStack.continueBubbling;
          }
        };

        return handlerStack.push({
          name: "suppress-trailing-key-events",
          keydown: handler,
          keypress: handler,
        });
      });
    }

    Mode.modes.push(this);
    this.setIndicator();
    this.logModes();
  }
  // End of Mode constructor.

  setIndicator(indicator) {
    if (indicator) {
      this.options.indicator = indicator;
    }
    return Mode.setIndicator();
  }

  static setIndicator() {
    return handlerStack.bubbleEvent("indicator");
  }

  push(handlers) {
    if (!handlers._name) {
      handlers._name = `mode-${this.id}`;
    }
    return this.handlers.push(handlerStack.push(handlers));
  }

  unshift(handlers) {
    if (!handlers._name) {
      handlers._name = `mode-${this.id}`;
    }
    this.handlers.push(handlerStack.unshift(handlers));
  }

  onExit(handler) {
    this.exitHandlers.push(handler);
  }

  exit(...args) {
    if (this.modeIsExiting || !this.modeIsActive) {
      return;
    }

    this.log("deactivate:", this.id);
    this.modeIsExiting = true;

    for (const handler of this.exitHandlers) {
      // TODO(philc): Is this array.from necessary?
      handler(...Array.from(args || []));
    }

    for (const handlerId of this.handlers) {
      handlerStack.remove(handlerId);
    }

    Mode.modes = Mode.modes.filter((mode) => mode !== this);

    this.modeIsActive = false;
    return this.setIndicator();
  }

  // Debugging routines.
  logModes() {
    if (Mode.debug) {
      this.log("active modes (top to bottom):");
      for (const mode of Mode.modes.slice().reverse()) {
        this.log(" ", mode.id);
      }
    }
  }

  log(...args) {
    if (Mode.debug) {
      console.log(...Array.from(args || []));
    }
  }

  // For tests only.
  static top() {
    return this.modes[this.modes.length - 1];
  }

  // For tests only.
  static reset() {
    for (const mode of this.modes) {
      mode.exit();
    }
    this.modes = [];
  }
}

// If Mode.debug is true, then we generate a trace of modes being activated and deactivated on the
// console.
Mode.debug = false;
Mode.modes = [];

class SuppressAllKeyboardEvents extends Mode {
  constructor(options) {
    if (options == null) {
      options = {};
    }
    super();
    const defaults = {
      name: "suppressAllKeyboardEvents",
      suppressAllKeyboardEvents: true,
    };
    super.init(Object.assign(defaults, options));
  }
}

class CacheAllKeydownEvents extends SuppressAllKeyboardEvents {
  constructor(options) {
    if (options == null) {
      options = {};
    }
    const keydownEvents = [];
    const defaults = {
      name: "cacheAllKeydownEvents",
      keydown(event) {
        return keydownEvents.push(event);
      },
    };
    super(Object.assign(defaults, options));
    this.keydownEvents = [];
  }

  replayKeydownEvents() {
    return this.keydownEvents.map((event) => handlerStack.bubbleEvent("keydown", event));
  }
}




  // =========================================================================
  // Shadow DOM HUD & Clipboard Bridge
  // =========================================================================
  const HUD = {
    findMode: null,
    historyIndex: -1,
    partialQuery: "",
    _hideTimer: null,
    _findWired: false,

    abandon() {
      this.hide(true, false);
    },

    ensureFindWired() {
      if (this._findWired) {
        return;
      }
      PhantomShadowUI.ensureMounted();
      const inputEl = PhantomShadowUI.findInputEl;
      if (!inputEl) {
        return;
      }
      this._findWired = true;

      inputEl.addEventListener("input", () => {
        if (!this.findMode) return;
        const query = inputEl.value;
        const selStart = inputEl.selectionStart;
        const selEnd = inputEl.selectionEnd;
        this.findMode.findInPlace(query, { postFindFocus: inputEl });
        try {
          if (typeof selStart === "number" && typeof selEnd === "number") {
            inputEl.setSelectionRange(selStart, selEnd);
          }
        } catch (_err) {}
        const matchCount = FindMode.query && FindMode.query.parsedQuery.length > 0 ? FindMode.query.matchCount : 0;
        const showMatchText = query.length > 0;
        PhantomShadowUI.findCountEl.textContent = showMatchText
          ? (matchCount > 0 ? ` (${matchCount} Match${matchCount === 1 ? "" : "es"})` : " (No matches)")
          : "";
      });

      inputEl.addEventListener("keydown", (event) => {
        const isEsc = KeyboardUtils.isEscape(event);
        const isEnter = event.key === "Enter";
        const isEmptyBackspace = KeyboardUtils.isBackspace(event) && inputEl.value.length === 0;

        if (isEsc || isEnter || isEmptyBackspace) {
          event.preventDefault();
          event.stopPropagation();
          this.hideFindMode({ exitEventIsEnter: isEnter, exitEventIsEscape: isEsc });
          return;
        }

        if (event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          const rawQuery = FindModeHistory.getQuery(this.historyIndex + 1);
          if (rawQuery) {
            this.historyIndex += 1;
            if (this.historyIndex === 0) {
              this.partialQuery = inputEl.value;
            }
            inputEl.value = rawQuery;
            inputEl.dispatchEvent(new Event("input", { bubbles: true }));
          }
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          event.stopPropagation();
          this.historyIndex = Math.max(-1, this.historyIndex - 1);
          const rawQuery = this.historyIndex >= 0 ? FindModeHistory.getQuery(this.historyIndex) : this.partialQuery;
          inputEl.value = rawQuery || "";
          inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
    },

    show(text, duration) {
      if (!isVimiumActive) return;
      if (!PhantomShadowUI.ensureMounted()) return;
      clearTimeout(this._hideTimer);
      PhantomShadowUI.hudEl.classList.remove("find-mode");
      PhantomShadowUI.hudEl.classList.add("visible");
      PhantomShadowUI.hudTextEl.textContent = text;
      if (duration != null) {
        this._hideTimer = setTimeout(() => this.hide(true, false), duration);
      }
    },

    showFindMode(findMode) {
      if (!isVimiumActive) return;
      this.findMode = findMode;
      this.historyIndex = -1;
      this.partialQuery = "";
      if (!PhantomShadowUI.ensureMounted()) return;
      this.ensureFindWired();
      clearTimeout(this._hideTimer);
      PhantomShadowUI.findInputEl.value = "";
      PhantomShadowUI.findCountEl.textContent = "";
      PhantomShadowUI.hudEl.classList.add("find-mode");
      PhantomShadowUI.hudEl.classList.add("visible");
      setTimeout(() => {
        try { PhantomShadowUI.findInputEl.focus(); } catch (_err) {}
      }, 0);
    },

    hide(immediate, updateIndicator) {
      clearTimeout(this._hideTimer);
      if (PhantomShadowUI.hudEl) {
        PhantomShadowUI.hudEl.classList.remove("visible");
        PhantomShadowUI.hudEl.classList.remove("find-mode");
        PhantomShadowUI.hudTextEl.textContent = "";
      }
      if (immediate && updateIndicator) {
        Mode.setIndicator();
      }
    },

    hideFindMode({ exitEventIsEnter, exitEventIsEscape }) {
      const activeFind = this.findMode;
      this.findMode = null;
      this.hide(true, false);

      if (!activeFind) {
        return;
      }

      try { PhantomShadowUI.findInputEl.blur(); } catch (_err) {}
      try { window.focus(); } catch (_err) {}

      if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === "function") {
        document.activeElement.blur();
      }

      const activeQuery =
        exitEventIsEnter && FindMode.query && FindMode.query.rawQuery
          ? (FindMode.query.isRegex ? FindMode.getQueryFromRegexMatches() : FindMode.query.parsedQuery)
          : null;

      if (exitEventIsEnter && activeQuery) {
        activeFind.restoreSelection();
        FindMode.query.hasResults = FindMode.execute(activeQuery, { postFindFocus: null });
        if (!FindMode.query.hasResults) {
          activeFind.checkReturnToViewPort();
        }
      } else {
        activeFind.checkReturnToViewPort();
      }

      const focusNode = DomUtils.getSelectionFocusElement();
      if (focusNode && typeof focusNode.focus === "function" && focusNode.tagName && focusNode.tagName.toLowerCase() === "a") {
        focusNode.focus();
      }

      let postExit = null;
      if (exitEventIsEnter) {
        FindMode.handleEnter();
        if (FindMode.query && FindMode.query.hasResults) {
          postExit = () => newPostFindMode();
        }
      } else if (exitEventIsEscape) {
        postExit = FindMode.handleEscape;
      }

      activeFind.exit();
      if (postExit) {
        postExit();
      }
    },

    unfocusIfFocused() {
      if (PhantomShadowUI.findInputEl && PhantomShadowUI.shadowRoot && PhantomShadowUI.shadowRoot.activeElement === PhantomShadowUI.findInputEl) {
        PhantomShadowUI.findInputEl.blur();
      }
    },

    copyToClipboard(text) {
      if (clipboardPolicy === "Block") {
        this.show("Clipboard disabled by exam policy.", 2000);
        return false;
      }

      const cleanText = String(text || "").replace(/\xa0/g, " ");

      if (clipboardPolicy === "Isolated" && window.SafeExamBrowser && window.SafeExamBrowser.clipboard) {
        try {
          window.SafeExamBrowser.clipboard.ranges = [];
          window.SafeExamBrowser.clipboard.text = cleanText;
          if (window.CefSharp && typeof window.CefSharp.PostMessage === "function") {
            window.CefSharp.PostMessage({
              Type: "Clipboard",
              Id: window.SafeExamBrowser.clipboard.id,
              Content: window.SafeExamBrowser.clipboard.getContentEncoded()
            });
          }
          return true;
        } catch (_err) {}
      }

      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(cleanText).catch(() => {});
        return true;
      }

      return false;
    },

    pasteFromClipboard(callback) {
      if (clipboardPolicy === "Block") {
        this.show("Clipboard disabled by exam policy.", 2000);
        return;
      }
      if (clipboardPolicy === "Isolated" && window.SafeExamBrowser && window.SafeExamBrowser.clipboard) {
        callback(window.SafeExamBrowser.clipboard.text || "");
        return;
      }
      if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
        navigator.clipboard.readText().then((val) => callback(val || "")).catch(() => {});
      }
    }
  };

  //
// This implements link hinting. Typing "F" will enter link-hinting mode, where all clickable items
// on the page have a hint marker displayed containing a sequence of letters. Typing those letters
// will select a link.
//
// In our 'default' mode, the characters we use to show link hints are a user-configurable option.
// By default they're the home row. The CSS which is used on the link hints is also a configurable
// option.
//
// In 'filter' mode, our link hints are numbers, and the user can narrow down the range of
// possibilities by typing the text of the link itself.
//

// Special cases for clickable elements on specific sites, which our general heuristics don't detect
// or don't activate correctly. Keyed by host. Each rule has:
// - selector: the elements which should get hints.
// - activation: how to activate them.
//   - "doubleClick": a single click only selects the element; it takes a double click to open it.
//   - "clickCenter": the page ignores clicks on the element itself, and only handles clicks on its
//     descendants, so click the descendant at the element's center, as a real click would.
const siteSpecificClickables = {
  // Files and folders are rows in Drive's list view, and grid cells in its grid view. Clicking on
  // them just selects them, which isn't useful. Double-clicking opens the file/folder. See #2919.
  "drive.google.com": {
    selector: '[role="row"][jsaction*="dblclick:"], [role="gridcell"][jsaction*="dblclick:"]',
    activation: "doubleClick",
  },
  // Files and templates on the Docs, Sheets and Slides home pages, in both grid and list views.
  "docs.google.com": {
    selector: '[role="listbox"] [role="option"]',
    activation: "clickCenter",
  },
};

// Returns the site-specific rule which applies to `element`, or null.
function siteSpecificRule(element) {
  const rule = siteSpecificClickables[globalThis.location.host];
  return rule != null && element.matches(rule.selector) ? rule : null;
}

// Returns the descendant of `element` at its center, or `element` if there's none.
function descendantAtCenter(element) {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const descendant = document.elementFromPoint(x, y);
  return (descendant != element && element.contains(descendant)) ? descendant : element;
}

function simulateClickForSite(element, modifiers) {
  switch (siteSpecificRule(element)?.activation) {
    case "doubleClick":
      return DomUtils.simulateDoubleClick(element, modifiers);
    case "clickCenter":
      return DomUtils.simulateClick(descendantAtCenter(element), modifiers);
    default:
      return DomUtils.simulateClick(element, modifiers);
  }
}

// A DOM element that sits on top of a link, showing the key the user should type to select the
// link.
class HintMarker {
  hintDescriptor;
  localHint;
  linkText; // Used in FilterHints
  hintString; // Used in AlphabetHints
  markerRect; // Cached rectangle of the element, used for rotating hints.
  // Element is null if the hint marker reflects a hint that's owned by another frame.
  element;
  // Cached book-keeping when computing a marker's score against a query.
  linkWords;
  score;
  stableSortCount;
  constructor() {
    Object.seal(this);
  }
  isLocalMarker() {
    return this.localHint != null;
  }
}

// A clickable element in the current frame, plus metadata about how to show a hint marker for it.
class LocalHint {
  element; // The clickable element.
  image; // When element is an <area> (image map), `image` is its associated image.
  rect; // The rectangle where the hint should shown, to avoid overlapping with other hints.
  linkText; // Used in FilterHints.
  showLinkText; // Used in FilterHints.
  // The reason that an element has a link hint when the reason isn't obvious, e.g. the body of a
  // frame so that the frame can be focused. This reason is shown to the user in the hint's caption.
  reason;
  // "secondClassCitizen" means the element isn't clickable, but does have a tab index. We show
  // hints for these elements unless their hit box collides with another clickable element.
  secondClassCitizen;
  // An element that may be clickable based on our heuristics. It's a "false positive" if one of its
  // child elements is detected as clickable.
  possibleFalsePositive;
  constructor(o) {
    Object.seal(this);
    if (o) {
      Object.assign(this, o);
    }
  }
}

// Metadata about each LocalHint which is transferred to other frames in the current tab, so that
// every frame can be aware of every other frame's local hints.
class HintDescriptor {
  frameId; // The frameId that the hint is local to.
  localIndex; // An index into the owner frame's localHints.
  linkText; // The link's text. This is non-null only for FilterHints.
  constructor(o) {
    Object.seal(this);
    if (o) {
      Object.assign(this, o);
    }
  }
}

// The "name" property below appears in the link-hints mode's name (e.g.
// "link-hints/open-in-current-tab"), which appears in the HUD's data-message-name attribute. This
// allows users to write CSS for each HUD message (hiding some of them).
const isMac = KeyboardUtils.platform === "Mac";
const OPEN_IN_CURRENT_TAB = {
  name: "open-in-current-tab",
  indicator: "Open link in current tab",
};
const OPEN_IN_NEW_BG_TAB = {
  name: "open-in-new-background-tab",
  indicator: "Open link in new window",
  clickModifiers: { metaKey: isMac, ctrlKey: !isMac },
  linkActivator(el) {
    const anchor = el.closest ? el.closest("a[href]") : (el.tagName && el.tagName.toLowerCase() === "a" ? el : null);
    if (anchor && anchor.href && !/^javascript:/i.test(anchor.href)) {
      chrome.runtime.sendMessage({ handler: "openUrlInNewWindow", url: anchor.href });
    } else {
      simulateClickForSite(el, {});
    }
  },
};
const OPEN_IN_NEW_FG_TAB = {
  name: "open-in-new-foreground-tab",
  indicator: "Open link in new window",
  clickModifiers: { shiftKey: true, metaKey: isMac, ctrlKey: !isMac },
  linkActivator(el) {
    const anchor = el.closest ? el.closest("a[href]") : (el.tagName && el.tagName.toLowerCase() === "a" ? el : null);
    if (anchor && anchor.href && !/^javascript:/i.test(anchor.href)) {
      chrome.runtime.sendMessage({ handler: "openUrlInNewWindow", url: anchor.href });
    } else {
      simulateClickForSite(el, {});
    }
  },
};
const OPEN_WITH_QUEUE = {
  name: "open-with-queue",
  indicator: "Open multiple links in new tabs",
  clickModifiers: { metaKey: isMac, ctrlKey: !isMac },
};
const COPY_LINK_URL = {
  name: "copy-link-url",
  indicator: "Copy link URL to Clipboard",
  linkActivator(link) {
    if (link.href != null) {
      let url = link.href;
      if (url.slice(0, 7) === "mailto:") {
        url = url.slice(7);
      }
      HUD.copyToClipboard(url);
      if (28 < url.length) {
        url = url.slice(0, 26) + "....";
      }
      HUD.show(`Yanked ${url}`, 2000);
    } else {
      HUD.show("No link to yank.", 2000);
    }
  },
};
const OPEN_INCOGNITO = {
  name: "open-incognito",
  indicator: "Open link in incognito window",
  linkActivator(link) {
    chrome.runtime.sendMessage({ handler: "openUrlInIncognito", url: link.href });
  },
};
const DOWNLOAD_LINK_URL = {
  name: "download-link-url",
  indicator: "Download link URL",
  clickModifiers: { altKey: true, ctrlKey: false, metaKey: false },
};
const COPY_LINK_TEXT = {
  name: "copy-link-text",
  indicator: "Copy link text",
  linkActivator(link) {
    let text = link.textContent;
    if (text.length > 0) {
      HUD.copyToClipboard(text);
      if (28 < text.length) {
        text = text.slice(0, 26) + "....";
      }
      HUD.show(`Yanked ${text}`, 2000);
    } else {
      HUD.show("No text to yank.", 2000);
    }
  },
};
const HOVER_LINK = {
  name: "hover-link",
  indicator: "Hover link",
  linkActivator(link) {
    new HoverMode(link);
  },
};
const FOCUS_LINK = {
  name: "focus-link",
  indicator: "Focus link",
  linkActivator(link) {
    link.focus();
  },
};

const availableModes = [
  OPEN_IN_CURRENT_TAB,
  OPEN_IN_NEW_BG_TAB,
  OPEN_IN_NEW_FG_TAB,
  OPEN_WITH_QUEUE,
  COPY_LINK_URL,
  OPEN_INCOGNITO,
  DOWNLOAD_LINK_URL,
  COPY_LINK_TEXT,
  HOVER_LINK,
  FOCUS_LINK,
];

const HintCoordinator = {
  onExit: [],
  localHints: null,
  cacheAllKeydownEvents: null,

  // A WeakRef to the last clicked element. We track this so that we can mouse of it if the user
  // types ESC after clicking on it. See #3073.
  lastClickedElementRef: null,

  // Returns if the HintCoordinator will handle a given LinkHintsMessage.
  // Some messages will not be handled in the case where the help dialog is shown, and is then
  // hidden, but is still receiving link hints messages via broadcastLinkHintsMessage.
  willHandleMessage(messageType) {
    if (this.linkHintsMode) {
      return true;
    }
    return ["prepareToActivateMode", "activateMode", "getHintDescriptors", "exit"].includes(
      messageType,
    );
  },

  sendMessage(messageType, request) {
    if (request == null) {
      request = {};
    }
    request = Object.assign(request, { messageType, handler: "broadcastLinkHintsMessage" });
    chrome.runtime.sendMessage(request);
  },

  prepareToActivateMode(mode, onExit) {
    // We need to communicate with the background page (and other frames) to initiate link-hints
    // mode. To prevent other Vimium commands from being triggered before link-hints mode is
    // launched, we install a temporary mode to block (and cache) keyboard events.
    let cacheAllKeydownEvents;
    this.cacheAllKeydownEvents = cacheAllKeydownEvents = new CacheAllKeydownEvents({
      name: "link-hints/suppress-keyboard-events",
      singleton: "link-hints-mode",
      indicator: "Collecting hints...",
      exitOnEscape: true,
    });
    // FIXME(smblott) Global link hints is currently insufficiently reliable. If the mode above is
    // left in place, then Vimium blocks. As a temporary measure, we install a timer to remove it.
    // TODO(philc): I believe link hints is sufficiently reliable after the manifest V3 port
    // that this safeguard can now be removed.
    Utils.setTimeout(1000, function () {
      if (cacheAllKeydownEvents && cacheAllKeydownEvents.modeIsActive) {
        cacheAllKeydownEvents.exit();
      }
    });
    this.onExit = [onExit];
    const protocol = globalThis.location.protocol;
    // chrome-extension, moz-extension (Firefox), extension (Edge).
    const isExtensionPage = protocol.endsWith("extension:");
    chrome.runtime.sendMessage({
      handler: "prepareToActivateLinkHintsMode",
      modeIndex: availableModes.indexOf(mode),
      isExtensionPage,
      requestedByHelpDialog: globalThis.isVimiumHelpDialog,
    });
  },

  // Returns a list of HintDescriptors. Hint descriptors are global. They include all of the
  // information necessary for each frame to determine whether and when a hint from *any* frame is
  // selected.
  getHintDescriptors({ modeIndex, requestedByHelpDialog }, _sender) {
    if (!DomUtils.isReady() || DomUtils.windowIsTooSmall()) {
      return [];
    }

    const requireHref = [COPY_LINK_URL, OPEN_INCOGNITO].includes(availableModes[modeIndex]);
    // If link hints is launched within the help dialog, then we only offer hints from that frame.
    // This improves the usability of the help dialog on the options page (particularly for
    // selecting command names).
    if (requestedByHelpDialog && !globalThis.isVimiumHelpDialog) {
      this.localHints = [];
    } else {
      this.localHints = LocalHints.getLocalHints(requireHref);
    }
    this.localHintDescriptors = this.localHints.map(({ linkText }, localIndex) => (
      new HintDescriptor({
        frameId,
        localIndex,
        linkText,
      })
    ));
    return this.localHintDescriptors;
  },

  // We activate LinkHintsMode() in every frame and provide every frame with exactly the same hint
  // descriptors. We also propagate the key state between frames. Therefore, the hint-selection
  // process proceeds in lock step in every frame, and this.linkHintsMode is in the same state in
  // every frame.
  activateMode({ frameId, frameIdToHintDescriptors, modeIndex, originatingFrameId }) {
    // We do not receive the frame's own hint descritors back from the background page. Instead, we
    // merge them with the hint descriptors from other frames here. Note that
    // this.localHintDescriptors can be null if "getHintDescriptors" failed in this frame when it
    // was last called, or if this frame didn't exist at the time that hints were requested.
    frameIdToHintDescriptors[frameId] = this.localHintDescriptors || [];
    this.localHintDescriptors = null;

    const hintDescriptors = Object.keys(frameIdToHintDescriptors)
      .sort()
      .flatMap((frame) => frameIdToHintDescriptors[frame]);

    if (this.cacheAllKeydownEvents?.modeIsActive) {
      this.cacheAllKeydownEvents.exit();
    }
    if (frameId !== originatingFrameId) {
      this.onExit = [];
    }
    this.linkHintsMode = new LinkHintsMode(hintDescriptors, availableModes[modeIndex]);
    // Replay keydown events which we missed (but for filtered hints only).
    if (Settings.get("filterLinkHints" && this.cacheAllKeydownEvents)) {
      this.cacheAllKeydownEvents.replayKeydownEvents();
    }
    this.cacheAllKeydownEvents = null;
  },

  // The following messages are exchanged between frames while link-hints mode is active.
  updateKeyState(request) {
    this.linkHintsMode.updateKeyState(request);
  },
  rotateHints() {
    this.linkHintsMode.rotateHints();
  },
  setOpenLinkMode({ modeIndex }) {
    this.linkHintsMode.setOpenLinkMode(availableModes[modeIndex], false);
  },
  activateActiveHintMarker() {
    this.linkHintsMode.activateLink(this.linkHintsMode.markerMatcher.activeHintMarker);
  },
  getLocalHint(hint) {
    return this.localHints[hint.localIndex];
  },

  exit({ isSuccess }) {
    if (this.linkHintsMode != null) {
      this.linkHintsMode.deactivateMode();
    }
    while (this.onExit.length > 0) {
      this.onExit.pop()(isSuccess);
    }
    this.linkHintsMode = this.localHints = null;
  },

  mouseOutOfLastClickedElement() {
    if (this.lastClickedElementRef == null) {
      return;
    }
    const el = this.lastClickedElementRef.deref();
    if (el) {
      DomUtils.simulateMouseEvent("mouseout", el, null);
    }
    this.lastClickedElementRef = null;
  },
};

const LinkHints = {
  activateMode(count, { mode, registryEntry }) {
    if (count == null) {
      count = 1;
    }
    if (mode == null) {
      mode = OPEN_IN_CURRENT_TAB;
    }

    switch (registryEntry?.options.action) {
      case "copy-text":
        mode = COPY_LINK_TEXT;
        break;
      case "hover":
        mode = HOVER_LINK;
        break;
      case "focus":
        mode = FOCUS_LINK;
        break;
    }

    if ((count > 0) || (mode === OPEN_WITH_QUEUE)) {
      HintCoordinator.prepareToActivateMode(mode, function (isSuccess) {
        if (isSuccess) {
          // Wait for the next tick to allow the previous mode to exit. It might yet generate a
          // click event, which would cause our new mode to exit immediately.
          Utils.nextTick(() => LinkHints.activateMode(count - 1, { mode }));
        }
      });
    }
  },

  activateModeToOpenInNewTab(count) {
    this.activateMode(count, { mode: OPEN_IN_NEW_BG_TAB });
  },
  activateModeToOpenInNewForegroundTab(count) {
    this.activateMode(count, { mode: OPEN_IN_NEW_FG_TAB });
  },
  activateModeToCopyLinkUrl(count) {
    this.activateMode(count, { mode: COPY_LINK_URL });
  },
  activateModeWithQueue() {
    this.activateMode(1, { mode: OPEN_WITH_QUEUE });
  },
  activateModeToOpenIncognito(count) {
    this.activateMode(count, { mode: OPEN_INCOGNITO });
  },
  activateModeToDownloadLink(count) {
    this.activateMode(count, { mode: DOWNLOAD_LINK_URL });
  },
};

class LinkHintsMode {
  // @mode: One of the enums listed at the top of this file.
  constructor(hintDescriptors, mode) {
    if (mode == null) {
      mode = OPEN_IN_CURRENT_TAB;
    }
    this.mode = mode;
    // We need documentElement to be ready in order to append links.
    if (!document.documentElement) {
      return;
    }

    this.containerEl = null;
    // Function that does the appropriate action on the selected link.
    this.linkActivator = undefined;
    // The link-hints "mode" (in the key-handler, indicator sense).
    this.hintMode = null;
    // A count of the number of Tab presses since the last non-Tab keyboard event.
    this.tabCount = 0;
    // Whether we're waiting for the user to confirm a single match before activating it. One of:
    //   null      - not confirming.
    //   "enter"   - waiting for an explicit Enter (confirm) or Escape (cancel).
    //   "timeout" - waiting for a pause in typing before confirming.
    this.confirming = null;

    if (hintDescriptors.length === 0) {
      HUD.show("No links to select.", 2000);
      return;
    }

    // This count is used to rank equal-scoring hints when sorting, thereby making JavaScript's sort
    // stable.
    this.stableSortCount = 0;
    this.hintMarkers = hintDescriptors.map((desc) => this.createMarkerFor(desc));
    this.markerMatcher = Settings.get("filterLinkHints") ? new FilterHints() : new AlphabetHints();
    this.markerMatcher.fillInMarkers(this.hintMarkers);

    this.hintMode = new Mode();
    this.hintMode.init({
      name: `link-hints/${this.mode.name}`,
      indicator: false,
      singleton: "link-hints-mode",
      suppressAllKeyboardEvents: true,
      suppressTrailingKeyEvents: true,
      exitOnEscape: true,
      exitOnClick: true,
      keydown: this.onKeyDownInMode.bind(this),
      keypress: this.onKeyPressInMode.bind(this),
    });

    this.hintMode.onExit((event) => {
      // If we were mid-confirmation (see beginConfirmation()), clear its pending timer.
      clearTimeout(this.confirmTimerId);
      this.confirming = null;

      const hintsWereCancelled = (event?.type === "click") ||
        ((event?.type === "keydown") &&
          (KeyboardUtils.isEscape(event) || KeyboardUtils.isBackspace(event)));
      if (hintsWereCancelled) {
        HintCoordinator.sendMessage("exit", { isSuccess: false });
      }
    });

    this.renderHints();
    this.setIndicator();
  }

  renderHints() {
    if (this.containerEl == null) {
      const div = DomUtils.createElement("div");
      div.id = "vimium-hint-marker-container";
      div.className = "vimium-reset";
      this.containerEl = div;
      PhantomShadowUI.getContainer().appendChild(div);
    }

    // Append these markers as top level children instead of as child nodes to the link itself,
    // because some clickable elements cannot contain children, e.g. submit buttons.
    const markerEls = this.hintMarkers.filter((m) => m.isLocalMarker()).map((m) => m.element);
    for (const el of markerEls) {
      this.containerEl.appendChild(el);
    }

    // TODO(philc): 2024-03-27 Remove this hasPopoverSupport check once Firefox has popover support.
    // Also move this CSS into vimium.css.
    const hasPopoverSupport = this.containerEl.showPopover != null;
    if (false && hasPopoverSupport) {
      this.containerEl.popover = "manual";
      this.containerEl.showPopover();
      Object.assign(this.containerEl.style, {
        top: 0,
        left: 0,
        position: "absolute",
        // This display: block is required to override Github Enterprise's CSS circa 2024-04-01. See
        // #4446.
        display: "block",
        width: "100%",
        height: "100%",
        overflow: "visible",
      });
    }

    this.setIndicator();
  }

  setOpenLinkMode(mode, shouldPropagateToOtherFrames) {
    this.mode = mode;
    if (shouldPropagateToOtherFrames == null) {
      shouldPropagateToOtherFrames = true;
    }
    if (shouldPropagateToOtherFrames) {
      HintCoordinator.sendMessage("setOpenLinkMode", {
        modeIndex: availableModes.indexOf(this.mode),
      });
    } else {
      this.setIndicator();
    }
  }

  setIndicator() {
    // If we're waiting for enter confirmation, we're showing an HUD message; don't clobber it.
    if (this.confirming === "enter") {
      return;
    }

    if (windowIsFocused()) {
      const typedCharacters = this.markerMatcher.linkTextKeystrokeQueue
        ? this.markerMatcher.linkTextKeystrokeQueue.join("")
        : "";
      const indicator = this.mode.indicator + (typedCharacters ? `: \"${typedCharacters}\"` : "") +
        ".";
      this.hintMode.setIndicator(indicator);
    }
  }

  // Creates a link marker for the given link.
  createMarkerFor(desc) {
    const marker = new HintMarker();
    const isLocalMarker = desc.frameId === frameId;
    if (isLocalMarker) {
      const localHint = HintCoordinator.getLocalHint(desc);
      const el = DomUtils.createElement("div");
      el.style.left = localHint.rect.left + "px";
      el.style.top = localHint.rect.top + "px";
      // Note that Vimium's CSS is user-customizable. We're adding the "vimiumHintMarker" class here
      // for users to customize. See further comments about this in vimium.css.
      el.className = "vimium-reset internal-vimium-hint-marker vimiumHintMarker";
      Object.assign(marker, {
        element: el,
        localHint,
      });
    }

    return Object.assign(marker, {
      hintDescriptor: desc,
      linkText: desc.linkText,
      stableSortCount: ++this.stableSortCount,
    });
  }

  // Handles all keyboard events.
  onKeyDownInMode(event) {
    if (this.confirming) {
      if ((this.confirming === "enter") && (event.key === "Enter")) {
        this.finishConfirmation(true);
      } else if (this.confirming === "timeout") {
        this.resetConfirmTimer();
      }
      // Escape isn't handled here. hintMode's own exitOnEscape handler (pushed above this one on
      // the stack, so it sees the event first) cancels it for us, the same as it does outside of
      // confirmation.
      return;
    }
    if (event.repeat) {
      return;
    }

    // NOTE(smblott) The modifier behaviour here applies only to alphabet hints.
    if (
      ["Control", "Shift"].includes(event.key) && !Settings.get("filterLinkHints") &&
      [OPEN_IN_CURRENT_TAB, OPEN_WITH_QUEUE, OPEN_IN_NEW_BG_TAB, OPEN_IN_NEW_FG_TAB].includes(
        this.mode,
      )
    ) {
      // Toggle whether to open the link in a new or current tab.
      const previousMode = this.mode;
      const key = event.key;

      switch (key) {
        case "Shift":
          this.setOpenLinkMode(
            this.mode === OPEN_IN_CURRENT_TAB ? OPEN_IN_NEW_BG_TAB : OPEN_IN_CURRENT_TAB,
          );
          break;
        case "Control":
          this.setOpenLinkMode(
            this.mode === OPEN_IN_NEW_FG_TAB ? OPEN_IN_NEW_BG_TAB : OPEN_IN_NEW_FG_TAB,
          );
          break;
      }

      this.hintMode.push({
        keyup: (event) => {
          if (event.key === key) {
            handlerStack.remove();
            this.setOpenLinkMode(previousMode);
          }
          return true; // Continue bubbling the event.
        },
      });
    } else if (KeyboardUtils.isBackspace(event)) {
      if (this.markerMatcher.popKeyChar()) {
        this.tabCount = 0;
        this.updateVisibleMarkers();
      } else {
        // Exit via @hintMode.exit(), so that the LinkHints.activate() "onExit" callback sees the
        // key event and knows not to restart hints mode.
        this.hintMode.exit(event);
      }
    } else if (event.key === "Enter") {
      // Activate the active hint, if there is one.  Only FilterHints uses an active hint.
      if (this.markerMatcher.activeHintMarker) {
        HintCoordinator.sendMessage("activateActiveHintMarker");
      }
    } else if (event.key === "Tab") {
      if (event.shiftKey) {
        this.tabCount--;
      } else {
        this.tabCount++;
      }
      this.updateVisibleMarkers();
    } else if ((event.key === " ") && this.markerMatcher.shouldRotateHints(event)) {
      HintCoordinator.sendMessage("rotateHints");
    } else {
      if (!event.repeat) {
        let keyChar = Settings.get("filterLinkHints")
          ? KeyboardUtils.getKeyChar(event)
          : KeyboardUtils.getKeyChar(event).toLowerCase();
        if (keyChar) {
          if (keyChar === "space") {
            keyChar = " ";
          }
          if (keyChar.length === 1) {
            this.tabCount = 0;
            this.markerMatcher.pushKeyChar(keyChar);
            this.updateVisibleMarkers();
          } else {
            return handlerStack.suppressPropagation;
          }
        }
      }
    }

    return handlerStack.suppressEvent;
  }

  onKeyPressInMode() {
    if (this.confirming === "timeout") {
      this.resetConfirmTimer();
    }
  }

  updateVisibleMarkers() {
    const { hintKeystrokeQueue, linkTextKeystrokeQueue } = this.markerMatcher;
    return HintCoordinator.sendMessage("updateKeyState", {
      hintKeystrokeQueue,
      linkTextKeystrokeQueue,
      tabCount: this.tabCount,
    });
  }

  updateKeyState({ hintKeystrokeQueue, linkTextKeystrokeQueue, tabCount }) {
    Object.assign(this.markerMatcher, { hintKeystrokeQueue, linkTextKeystrokeQueue });

    const { linksMatched, userMightOverType } = this.markerMatcher.getMatchingHints(
      this.hintMarkers,
      tabCount,
    );
    if (linksMatched.length === 0) {
      this.deactivateMode();
    } else if (linksMatched.length === 1) {
      this.activateLink(linksMatched[0], userMightOverType);
    } else {
      for (const marker of this.hintMarkers) {
        this.hideMarker(marker);
      }
      for (const matched of linksMatched) {
        this.showMarker(matched, this.markerMatcher.hintKeystrokeQueue.length);
      }
    }

    return this.setIndicator();
  }

  markerOverlapsStack(marker, stack) {
    for (const otherMarker of stack) {
      if (Rect.intersects(marker.markerRect, otherMarker.markerRect)) {
        return true;
      }
    }
    return false;
  }

  // Rotate the hints' z-index values so that hidden hints become visible.
  rotateHints() {
    // Partitions array into two arrays, based on the bool return value of predicate.
    function partition(array, predicate) {
      const a = [];
      const b = [];
      for (const item of array) {
        const target = predicate(item) ? a : b;
        target.push(item);
      }
      return [a, b];
    }

    // Get local, visible hint markers.
    const [localMarkers, otherMarkers] = partition(
      this.hintMarkers,
      (m) => m.isLocalMarker() && (m.element.style.display !== "none"),
    );

    // Fill in the markers' rects, if necessary.
    for (const m of localMarkers) {
      if (m.markerRect == null) {
        m.markerRect = m.element.getClientRects()[0];
      }
    }

    // Calculate the overlapping groups of hints. We call each group a "stack". This is O(n^2).
    let stacks = [];
    for (const m of localMarkers) {
      let stackForThisMarker = null;
      const results = [];
      for (const stack of stacks) {
        const markerOverlapsThisStack = this.markerOverlapsStack(m, stack);
        if (markerOverlapsThisStack && (stackForThisMarker == null)) {
          // We've found an existing stack for this marker.
          stack.push(m);
          stackForThisMarker = stack;
          results.push(stack);
        } else if (markerOverlapsThisStack && (stackForThisMarker != null)) {
          // This marker overlaps a second (or subsequent) stack; merge that stack into
          // stackForThisMarker and discard it.
          stackForThisMarker.push(...stack);
          continue; // Discard this stack.
        } else {
          stack; // Keep this stack.
          results.push(stack);
        }
      }
      stacks = results;

      if (stackForThisMarker == null) {
        stacks.push([m]);
      }
    }

    let newMarkers = [];
    for (let stack of stacks) {
      if (stack.length > 1) {
        // Push the last element to the beginning.
        stack = stack.splice(-1, 1).concat(stack);
      }
      newMarkers.push(...stack);
    }

    newMarkers = newMarkers.concat(otherMarkers);
    this.hintMarkers = newMarkers;
    this.renderHints();
  }

  // When only one hint remains, activate it in the appropriate way. The current frame may or may
  // not contain the matched link, and may or may not have the focus. The resulting four cases are
  // accounted for here by selectively pushing the appropriate HintCoordinator.onExit handlers.
  activateLink(linkMatched, userMightOverType) {
    let clickEl;
    if (userMightOverType == null) {
      userMightOverType = false;
    }
    this.removeHintMarkers();

    if (linkMatched.isLocalMarker()) {
      const localHint = linkMatched.localHint;
      clickEl = localHint.element;
      HintCoordinator.onExit.push((isSuccess) => {
        if (isSuccess) {
          if (localHint.reason === "Frame.") {
            return Utils.nextTick(() => focusThisFrame({ highlight: true }));
          } else if (localHint.reason === "Scroll.") {
            // Tell the scroller that this is the activated element.
            return handlerStack.bubbleEvent(Utils.isFirefox() ? "click" : "DOMActivate", {
              target: clickEl,
            });
          } else if (localHint.reason === "Open.") {
            return clickEl.open = !clickEl.open;
          } else if (DomUtils.isSelectable(clickEl)) {
            globalThis.focus();
            return DomUtils.simulateSelect(clickEl);
          } else {
            const clickActivator = (modifiers) => (link) => simulateClickForSite(link, modifiers);
            const linkActivator = this.mode.linkActivator != null
              ? this.mode.linkActivator
              : clickActivator(this.mode.clickModifiers);
            // Note(gdh1995): Here we should allow special elements to get focus,
            // <select>: latest Chrome refuses `mousedown` event, and we can only focus it to let
            //     user press space to activate the popup menu
            // <object> & <embed>: for Flash games which have their own key event handlers since we
            //     have been able to blur them by pressing `Escape`
            if (["input", "select", "object", "embed"].includes(clickEl.nodeName.toLowerCase())) {
              clickEl.focus();
              if (clickEl.nodeName.toLowerCase() === "select" && typeof clickEl.showPicker === "function") {
                try { clickEl.showPicker(); } catch (_err) {}
              }
            }
            HintCoordinator.lastClickedElementRef = new WeakRef(clickEl);
            return linkActivator(clickEl);
          }
        }
      });
    }

    // If flash elements are created, then this function can be used later to remove them.
    let removeFlashElements = function () {};
    if (linkMatched.isLocalMarker()) {
      const { top: viewportTop, left: viewportLeft } = DomUtils.getViewportTopLeft();
      const flashElements = Array.from(clickEl.getClientRects()).map((rect) =>
        DomUtils.addFlashRect(Rect.translate(rect, viewportLeft, viewportTop))
      );
      removeFlashElements = () => flashElements.map((flashEl) => DomUtils.removeElement(flashEl));
    }

    // If we're using a keyboard blocker, then the frame with the focus sends the "exit" message,
    // otherwise the frame containing the matched link does.
    if (userMightOverType) {
      HintCoordinator.onExit.push(removeFlashElements);
      if (windowIsFocused()) {
        const callback = (isSuccess) => HintCoordinator.sendMessage("exit", { isSuccess });
        this.beginConfirmation(callback);
      }
    } else if (linkMatched.isLocalMarker()) {
      Utils.setTimeout(400, removeFlashElements);
      return HintCoordinator.sendMessage("exit", { isSuccess: true });
    }
  }

  // Called when exactly one hint matches, but the user might still be mid-way through typing a
  // longer link text that would match a different hint. We take over key handling to decide whether
  // to commit to this hint:
  //   - waitForEnterForFilteredHints on: wait for an explicit Enter (confirm) or Escape (cancel).
  //   - otherwise: wait for the user to stop typing for a short delay, then confirm.
  // Escape will cancel this mode via hintMode's own exitOnEscape handling.
  beginConfirmation(callback) {
    this.confirmCallback = callback;
    if (Settings.get("waitForEnterForFilteredHints")) {
      this.confirming = "enter";
      this.hintMode.setIndicator("Hit <Enter> to proceed...");
    } else {
      this.confirming = "timeout";
      this.resetConfirmTimer();
    }
  }

  resetConfirmTimer() {
    clearTimeout(this.confirmTimerId);
    this.confirmTimerId = Utils.setTimeout(200, () => this.finishConfirmation(true));
  }

  finishConfirmation(isSuccess) {
    this.confirming = null;
    this.confirmCallback(isSuccess);
  }

  // Shows the marker, highlighting matchingCharCount characters.
  showMarker(linkMarker, matchingCharCount) {
    if (!linkMarker.isLocalMarker()) {
      return;
    }

    linkMarker.element.style.display = "";
    for (let j = 0, end = linkMarker.element.childNodes.length; j < end; j++) {
      if (j < matchingCharCount) {
        linkMarker.element.childNodes[j].classList.add("matchingCharacter");
      } else {
        linkMarker.element.childNodes[j].classList.remove("matchingCharacter");
      }
    }
  }

  hideMarker(marker) {
    if (marker.isLocalMarker()) {
      marker.element.style.display = "none";
    }
  }

  deactivateMode() {
    this.removeHintMarkers();
    if (this.hintMode != null) {
      this.hintMode.exit();
    }
  }

  removeHintMarkers() {
    if (this.containerEl) {
      DomUtils.removeElement(this.containerEl);
    }
    this.containerEl = null;
  }
}

// Use characters for hints, and do not filter links by their text.
class AlphabetHints {
  constructor() {
    this.linkHintCharacters = Settings.get("linkHintCharacters").toLowerCase();
    // Ensure we have more than 1 character to generate hint strings. With 1 character, every hint
    // will be another hint's prefix ("1", "11", ...).
    if (this.linkHintCharacters.length <= 1) {
      throw new Error("The linkHintCharacters setting must have more than 1 character.");
    }
    this.hintKeystrokeQueue = [];
  }

  fillInMarkers(hintMarkers) {
    const hintStrings = this.hintStrings(hintMarkers.length);
    if (hintMarkers.length != hintStrings.length) {
      // This can only happen if the user's linkHintCharacters setting is empty.
      console.warn("Unable to generate link hint strings.");
    } else {
      for (let i = 0; i < hintMarkers.length; i++) {
        const marker = hintMarkers[i];
        marker.hintString = hintStrings[i];
        if (marker.isLocalMarker()) {
          marker.element.innerHTML = spanWrap(marker.hintString.toUpperCase());
        }
      }
    }
  }

  //
  // Returns a list of hint strings which will uniquely identify the given number of links. The hint
  // strings may be of different lengths.
  //
  hintStrings(linkCount) {
    let hints = [""];
    let offset = 0;
    while (((hints.length - offset) < linkCount) || (hints.length === 1)) {
      const hint = hints[offset++];
      for (const ch of this.linkHintCharacters) {
        hints.push(ch + hint);
      }
    }
    hints = hints.slice(offset, offset + linkCount);

    // Shuffle the hints so that they're scattered; hints starting with the same character and short
    // hints are spread evenly throughout the array.
    return hints.sort().map((str) => str.reverse());
  }

  getMatchingHints(hintMarkers) {
    const matchString = this.hintKeystrokeQueue.join("");
    return {
      linksMatched: hintMarkers.filter((m) => m.hintString.startsWith(matchString)),
    };
  }

  pushKeyChar(keyChar) {
    this.hintKeystrokeQueue.push(keyChar);
  }

  popKeyChar() {
    return this.hintKeystrokeQueue.pop();
  }

  // For alphabet hints, <Space> always rotates the hints, regardless of modifiers.
  shouldRotateHints() {
    return true;
  }
}

// Use characters for hints, and also filter links by their text.
class FilterHints {
  constructor() {
    this.linkHintNumbers = Settings.get("linkHintNumbers").toUpperCase();
    // Ensure we have more than 1 character to generate hint strings. With 1 character, every hint
    // will be another hint's prefix ("1", "11", ...).
    if (this.linkHintNumbers.length <= 1) {
      throw new Error("The linkHintNumbers setting must have more than 1 character.");
    }

    this.hintKeystrokeQueue = [];
    this.linkTextKeystrokeQueue = [];
    this.activeHintMarker = null;
    // The regexp for splitting typed text and link texts. We split on sequences of non-word
    // characters and link-hint numbers.
    this.splitRegexp = new RegExp(
      `[\\W${Utils.escapeRegexSpecialCharacters(this.linkHintNumbers)}]+`,
    );
  }

  generateHintString(linkHintNumber) {
    const base = this.linkHintNumbers.length;
    const hint = [];
    while (linkHintNumber > 0) {
      hint.push(this.linkHintNumbers[Math.floor(linkHintNumber % base)]);
      linkHintNumber = Math.floor(linkHintNumber / base);
    }
    return hint.reverse().join("");
  }

  // Populates the marker's element with the correct caption.
  renderMarker(marker) {
    let linkText = marker.linkText;
    if (linkText.length > 35) {
      linkText = linkText.slice(0, 33) + "...";
    }
    const caption = marker.hintString + (marker.localHint.showLinkText ? ": " + linkText : "");
    marker.element.innerHTML = spanWrap(caption);
  }

  fillInMarkers(hintMarkers) {
    for (const marker of hintMarkers) {
      if (marker.isLocalMarker()) {
        this.renderMarker(marker);
      }
    }

    // We use getMatchingHints() here (although we know that all of the hints will match) to get an
    // order on the hints and highlight the first one.
    return this.getMatchingHints(hintMarkers, 0);
  }

  getMatchingHints(hintMarkers, tabCount) {
    // At this point, linkTextKeystrokeQueue and hintKeystrokeQueue have been updated to reflect the
    // latest input. Use them to filter the link hints accordingly.
    const matchString = this.hintKeystrokeQueue.join("");
    let linksMatched = this.filterLinkHints(hintMarkers);
    linksMatched = linksMatched.filter((linkMarker) =>
      linkMarker.hintString.startsWith(matchString)
    );

    // Visually highlight the active hint (that is, the one that will be activated if the user types
    // <Enter>).
    tabCount = ((linksMatched.length * Math.abs(tabCount)) + tabCount) % linksMatched.length;

    if (this.activeHintMarker?.element) {
      this.activeHintMarker.element.classList.remove("vimiumActiveHintMarker");
    }

    this.activeHintMarker = linksMatched[tabCount];

    if (this.activeHintMarker?.element) {
      this.activeHintMarker.element.classList.add("vimiumActiveHintMarker");
    }

    return {
      linksMatched,
      userMightOverType: (this.hintKeystrokeQueue.length === 0) &&
        (this.linkTextKeystrokeQueue.length > 0),
    };
  }

  pushKeyChar(keyChar) {
    if (this.linkHintNumbers.indexOf(keyChar) >= 0) {
      this.hintKeystrokeQueue.push(keyChar);
    } else if (
      (keyChar.toLowerCase() !== keyChar) &&
      (this.linkHintNumbers.toLowerCase() !== this.linkHintNumbers.toUpperCase())
    ) {
      // The keyChar is upper case and the link hint "numbers" contain characters (e.g.
      // [a-zA-Z]). We don't want some upper-case letters matching hints (above) and some matching
      // text (below), so we ignore such keys.
      return;
      // We only accept <Space> and characters which are not used for splitting (e.g. "a", "b",
      // etc., but not "-").
    } else if ((keyChar === " ") || !this.splitRegexp.test(keyChar)) {
      // Since we might renumber the hints, we should reset the current hintKeyStrokeQueue.
      this.hintKeystrokeQueue = [];
      this.linkTextKeystrokeQueue.push(keyChar.toLowerCase());
    }
  }

  popKeyChar() {
    return this.hintKeystrokeQueue.pop() || this.linkTextKeystrokeQueue.pop();
  }

  // Filter link hints by search string, renumbering the hints as necessary.
  filterLinkHints(hintMarkers) {
    const scoreFunction = this.scoreLinkHint(this.linkTextKeystrokeQueue.join(""));
    const matchingHintMarkers = hintMarkers
      .filter((linkMarker) => {
        linkMarker.score = scoreFunction(linkMarker);
        return (this.linkTextKeystrokeQueue.length === 0) || (linkMarker.score > 0);
      }).sort(function (a, b) {
        if (b.score === a.score) {
          return b.stableSortCount - a.stableSortCount;
        } else {
          return b.score - a.score;
        }
      });

    if (
      (matchingHintMarkers.length === 0) && (this.hintKeystrokeQueue.length === 0) &&
      (this.linkTextKeystrokeQueue.length > 0)
    ) {
      // We don't accept typed text which doesn't match any hints.
      this.linkTextKeystrokeQueue.pop();
      return this.filterLinkHints(hintMarkers);
    } else {
      let linkHintNumber = 1;
      return matchingHintMarkers.map((m) => {
        m.hintString = this.generateHintString(linkHintNumber++);
        if (m.isLocalMarker()) {
          this.renderMarker(m);
        }
        return m;
      });
    }
  }

  // Assign a score to a filter match (higher is better). We assign a higher score for matches at
  // the start of a word, and a considerably higher score still for matches which are whole words.
  scoreLinkHint(linkSearchString) {
    const searchWords = linkSearchString.trim().toLowerCase().split(this.splitRegexp);
    return (linkMarker) => {
      if (!(searchWords.length > 0)) {
        return 0;
      }

      // We only keep non-empty link words. Empty link words cannot be matched, and leading empty
      // link words disrupt the scoring of matches at the start of the text.
      if (!linkMarker.linkWords) {
        linkMarker.linkWords = linkMarker.linkText.toLowerCase().split(this.splitRegexp).filter(
          (term) => term,
        );
      }

      const linkWords = linkMarker.linkWords;

      const searchWordScores = searchWords.map((searchWord) => {
        const linkWordScores = linkWords.map((linkWord, idx) => {
          const position = linkWord.indexOf(searchWord);
          if (position < 0) {
            return 0; // No match.
          } else if ((position === 0) && (searchWord.length === linkWord.length)) {
            if (idx === 0) {
              return 8;
            } else {
              return 4;
            } // Whole-word match.
          } else if (position === 0) {
            if (idx === 0) {
              return 6;
            } else {
              return 2;
            } // Match at the start of a word.
          } else {
            return 1;
          }
        }); // 0 < position; other match.

        return Math.max(...linkWordScores);
      });

      if (searchWordScores.includes(0)) {
        return 0;
      } else {
        const addFunc = (a, b) => a + b;
        const score = searchWordScores.reduce(addFunc, 0);
        // Prefer matches in shorter texts. To keep things balanced for links without any text, we
        // just weight them as if their length was 100 (so, quite long).
        return score / Math.log(1 + (linkMarker.linkText.length || 100));
      }
    };
  }

  // For filtered hints, we require a modifier (because <Space> on its own is a token separator).
  shouldRotateHints(event) {
    return event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;
  }
}

//
// Make each hint character a span, so that we can highlight the typed characters as you type them.
//
const spanWrap = (hintString) => {
  const innerHTML = [];
  for (const char of hintString) {
    innerHTML.push("<span class='vimium-reset'>" + char + "</span>");
  }
  return innerHTML.join("");
};

const LocalHints = {
  // Returns an array of LocalHints if the element is visible and clickable, and computes the rect
  // which bounds this element in the viewport. We return an array because there may be more than
  // one part of element which is clickable (for example, if it's an image); if so, each LocalHint
  // represents one of the clickable rectangles of the element.
  getLocalHintsForElement(element) {
    // Get the tag name. However, `element.tagName` can be an element (not a string, see #2035), so
    // we guard against that.
    const tagName = element.tagName.toLowerCase?.() || "";
    let isClickable = false;
    let onlyHasTabIndex = false;
    let possibleFalsePositive = false;
    const hints = [];
    const imageMapAreas = [];
    let reason = null;

    // Insert area elements that provide click functionality to an img.
    if (tagName === "img") {
      let mapName = element.getAttribute("usemap");
      if (mapName) {
        const imgClientRects = element.getClientRects();
        mapName = mapName.replace(/^#/, "").replace('"', '\\"');
        const map = document.querySelector(`map[name=\"${mapName}\"]`);
        if (map && (imgClientRects.length > 0)) {
          isClickable = true;
          const areas = map.getElementsByTagName("area");
          let areasAndRects = DomUtils.getClientRectsForAreas(imgClientRects[0], areas);
          // We use this image property when detecting overlapping links.
          areasAndRects = areasAndRects.map((o) => Object.assign(o, { image: element }));
          imageMapAreas.push(...areasAndRects);
        }
      }
    }

    // Check aria properties to see if the element should be ignored.
    // Note that we're showing hints for elements with aria-hidden=true. See #3501 for discussion.
    const ariaDisabled = element.getAttribute("aria-disabled");
    if (ariaDisabled && ["", "true"].includes(ariaDisabled.toLowerCase())) {
      return []; // This element should never have a link hint.
    }

    // Check for AngularJS listeners on the element.
    if (!this.checkForAngularJs) {
      this.checkForAngularJs = (function () {
        const angularElements = document.getElementsByClassName("ng-scope");
        if (angularElements.length === 0) {
          return () => false;
        } else {
          const ngAttributes = [];
          for (const prefix of ["", "data-", "x-"]) {
            for (const separator of ["-", ":", "_"]) {
              ngAttributes.push(`${prefix}ng${separator}click`);
            }
          }
          return function (element) {
            for (const attribute of ngAttributes) {
              if (element.hasAttribute(attribute)) {
                return true;
              }
            }
            return false;
          };
        }
      })();
    }

    if (!isClickable) {
      isClickable = this.checkForAngularJs(element);
    }

    if (element.hasAttribute("onclick")) {
      isClickable = true;
    } else {
      const role = element.getAttribute("role");
      const clickableRoles = [
        "button",
        "tab",
        "link",
        "checkbox",
        "menuitem",
        "menuitemcheckbox",
        "menuitemradio",
        "radio",
        "textbox",
        "switch",
        "option",
        "combobox",
        "listbox",
        "treeitem",
      ];
      if (role != null && clickableRoles.includes(role.toLowerCase())) {
        isClickable = true;
      } else {
        const contentEditable = element.getAttribute("contentEditable");
        if (
          contentEditable != null &&
          ["", "contenteditable", "true"].includes(contentEditable.toLowerCase())
        ) {
          isClickable = true;
        }
      }
    }

    // Check for jsaction event listeners on the element.
    if (!isClickable && element.hasAttribute("jsaction")) {
      const jsactionRules = element.getAttribute("jsaction").split(";");
      for (const jsactionRule of jsactionRules) {
        const ruleSplit = jsactionRule.trim().split(":");
        if ((ruleSplit.length >= 1) && (ruleSplit.length <= 2)) {
          // A rule without an event type is for click events.
          const [eventType, handler] = ruleSplit.length === 1 ? ["click", ruleSplit[0]] : ruleSplit;
          // Handlers used to have the form "namespace.actionName". Google's sites now use a
          // single opaque name, like "click:h5M12e" on Google Drive's file rows. See #2919.
          const [namespace, actionName] = handler.trim().split(".");
          const isInactive = ["none", "_"].includes(namespace) || (actionName === "_");
          if (!isClickable) {
            isClickable = (eventType === "click") && !isInactive;
          }
        }
      }
    }

    if (!isClickable && siteSpecificRule(element)) {
      isClickable = true;
    }

    // Check for tagNames which are natively clickable.
    switch (tagName) {
      case "a":
        isClickable = true;
        break;
      case "textarea":
        isClickable ||= !element.disabled && !element.readOnly;
        break;
      case "input":
        isClickable ||= !((element.getAttribute("type")?.toLowerCase() == "hidden") ||
          element.disabled ||
          (element.readOnly && DomUtils.isSelectable(element)));
        break;
      case "button":
      case "select":
        isClickable ||= !element.disabled;
        break;
      case "object":
      case "embed":
        isClickable = true;
        break;
      case "label":
        isClickable ||= (element.control != null &&
          !element.control.disabled &&
          ((this.getLocalHintsForElement(element.control)).length === 0)) ||
          element.hasAttribute("for");
        break;
      case "body":
        isClickable ||= (element === document.body) && !windowIsFocused() &&
            (globalThis.innerWidth > 3) && (globalThis.innerHeight > 3) &&
            ((document.body != null ? document.body.tagName.toLowerCase() : undefined) !==
              "frameset")
          ? (reason = "Frame.")
          : undefined;
        isClickable ||= (element === document.body) && windowIsFocused() &&
            Scroller.isScrollableElement(element)
          ? (reason = "Scroll.")
          : undefined;
        break;
      case "img":
        isClickable ||= ["zoom-in", "zoom-out"].includes(element.style.cursor);
        break;
      case "div":
      case "ol":
      case "ul":
        isClickable ||=
          (element.clientHeight < element.scrollHeight) && Scroller.isScrollableElement(element)
            ? (reason = "Scroll.")
            : undefined;
        break;
      case "details":
        isClickable = true;
        reason = "Open.";
        break;
    }

    // NOTE(smblott) Disabled pending resolution of #2997.
    // # Detect elements with "click" listeners installed with `addEventListener()`.
    // isClickable ||= element.hasAttribute "_vimium-has-onclick-listener"

    // An element with a class name containing the text "button" might be clickable. However, real
    // clickables are often wrapped in elements with such class names. So, when we find clickables
    // based only on their class name, we mark them as unreliable.
    if (!isClickable) {
      const className = element.getAttribute("class")?.toLowerCase();
      if (className?.includes("button") || className?.includes("btn")) {
        isClickable = true;
        possibleFalsePositive = true;
      }
    }

    // If the span is clickable but wraps something else that is clickable, we want to instead favor
    // showing hints for descendants which are clickable. Flag the span as a possible false postive.
    if (tagName == "span") {
      possibleFalsePositive = true;
    }

    // Elements with tabindex are sometimes useful, but usually not. We can treat them as second
    // class citizens when it improves UX, so take special note of them.
    const tabIndexValue = element.getAttribute("tabindex");
    const tabIndex = tabIndexValue ? parseInt(tabIndexValue) : -1;
    if (!isClickable && !(tabIndex < 0) && !isNaN(tabIndex)) {
      isClickable = true;
      onlyHasTabIndex = true;
    }

    if (isClickable) {
      // An image map has multiple clickable areas, and so can represent multiple LocalHints.
      if (imageMapAreas.length > 0) {
        const mapHints = imageMapAreas.map((areaAndRect) => {
          return new LocalHint({
            element: areaAndRect.element,
            image: element,
            // element,
            rect: areaAndRect.rect,
            secondClassCitizen: onlyHasTabIndex,
            possibleFalsePositive,
            reason,
          });
        });
        hints.push(...mapHints);
      } else {
        const clientRect = DomUtils.getVisibleClientRect(element, true);
        if (clientRect !== null) {
          const hint = new LocalHint({
            element,
            rect: clientRect,
            secondClassCitizen: onlyHasTabIndex,
            possibleFalsePositive,
            reason,
          });
          hints.push(hint);
        }
      }
    }

    return hints;
  },

  //
  // Returns element at a given (x,y) with an optional root element.
  // If the returned element is a shadow root, descend into that shadow root recursively until we
  // hit an actual element.
  getElementFromPoint(x, y, root, stack) {
    if (root == null) {
      root = document;
    }
    if (stack == null) {
      stack = [];
    }
    const element = root.elementsFromPoint
      ? root.elementsFromPoint(x, y)[0]
      : root.elementFromPoint(x, y);

    if (stack.includes(element)) {
      return element;
    }

    stack.push(element);

    if (element && element.shadowRoot) {
      // A shadow root can contain just a text node; see #4620. In that case, return the shadow root
      // itself.
      return LocalHints.getElementFromPoint(x, y, element.shadowRoot, stack) || element;
    }

    return element;
  },

  // Returns an array of LocalHints representing all clickable elements that are not hidden and are
  // in the current viewport, along with rectangles at which (parts of) the elements are displayed.
  // In the process, we try to find rects where elements do not overlap so that link hints are
  // unambiguous. Because of this, the rects returned will frequently *NOT* be equivalent to the
  // rects for the whole element.
  // - requireHref: true if the hintable element must have an href, because an href is required for
  //   commands like "LinkHints.activateModeToCopyLinkUrl".
  getLocalHints(requireHref) {
    // We need documentElement to be ready in order to find links.
    if (!document.documentElement) {
      return [];
    }

    // Find all elements, recursing into shadow DOM if present.
    const getAllElements = (root, elements) => {
      if (elements == null) {
        elements = [];
      }
      for (const element of Array.from(root.querySelectorAll("*"))) {
        elements.push(element);
        if (element.shadowRoot) {
          getAllElements(element.shadowRoot, elements);
        }
      }
      return elements;
    };

    const elements = getAllElements(document.documentElement);
    let localHints = [];

    // The order of elements here is important; they should appear in the order they are in the DOM,
    // so that we can work out which element is on top when multiple elements overlap. Detecting
    // elements in this loop is the sensible, efficient way to ensure this happens.
    // NOTE(mrmr1993): Our previous method (combined XPath and DOM traversal for jsaction) couldn't
    // provide this, so it's necessary to check whether elements are clickable in order, as we do
    // below.
    for (const element of Array.from(elements)) {
      if (!requireHref || !!element.href) {
        const hints = this.getLocalHintsForElement(element);
        localHints.push(...hints);
      }
    }

    // Traverse the DOM from descendants to ancestors, so later elements show above earlier ones.
    localHints = localHints.reverse();

    // Filter out suspected false positives. A false positive is taken to be an element marked as a
    // possible false positive for which a close descendant is already clickable. False positives
    // tend to be close together in the DOM, so - to keep the cost down - we only search nearby
    // elements. NOTE(smblott): The visible elements have already been reversed, so we're visiting
    // descendants before their ancestors.
    // This determines how many descendants we're willing to consider.
    const descendantsToCheck = [1, 2, 3];
    localHints = localHints.filter((hint, position) => {
      if (!hint.possibleFalsePositive) {
        return true;
      }
      // Determine if the clickable element is indeed a false positive.
      const lookbackWindow = 6;
      let index = Math.max(0, position - lookbackWindow);
      while (index < position) {
        let candidateDescendant = localHints[index].element;
        for (const _ of descendantsToCheck) {
          candidateDescendant = candidateDescendant?.parentElement;
          if (candidateDescendant === hint.element) {
            // This is a false positive; exclude it from visibleElements.
            return false;
          }
        }
        index += 1;
      }
      return true;
    });

    // This loop will check if any corner or center of element is clickable.
    // document.elementFromPoint will find an element at a x,y location.
    // Node.contain checks to see if an element contains another. note: someNode.contains(someNode)
    // === true. If we do not find our element as a descendant of any element we find, assume it's
    // completely covered.

    const nonOverlappingHints = localHints.filter((hint) => {
      if (hint.secondClassCitizen) {
        return false;
      }
      const rect = hint.rect;

      // Check middle of element first, as this is perhaps most likely to return true.
      const elementFromMiddlePoint = LocalHints.getElementFromPoint(
        rect.left + (rect.width * 0.5),
        rect.top + (rect.height * 0.5),
      );
      const hasIntersection = elementFromMiddlePoint &&
        (hint.element.contains(elementFromMiddlePoint) ||
          elementFromMiddlePoint.contains(hint.element));
      if (hasIntersection) {
        return true;
      }

      // Handle image maps
      if (hint.element.localName == "area" && elementFromMiddlePoint == hint.image) {
        return true;
      }

      // If not in middle, try corners.
      // Adjusting the rect by 0.1 towards the upper left, which empirically fixes some cases where
      // another element would've been found instead. NOTE(philc): This isn't well explained.
      // Originated in #2251.
      const verticalCoords = [rect.top + 0.1, rect.bottom - 0.1];
      const horizontalCoords = [rect.left + 0.1, rect.right - 0.1];

      for (const verticalCoord of verticalCoords) {
        for (const horizontalCoord of horizontalCoords) {
          const elementFromPoint = LocalHints.getElementFromPoint(horizontalCoord, verticalCoord);
          const hasIntersection = elementFromPoint &&
            (hint.element.contains(elementFromPoint) || elementFromPoint.contains(hint.element));
          if (hasIntersection) {
            return true;
          }
        }
      }
    });

    nonOverlappingHints.reverse();

    // Position the rects within the window.
    const { top, left } = DomUtils.getViewportTopLeft();
    for (const hint of nonOverlappingHints) {
      hint.rect.top += top;
      hint.rect.left += left;
    }

    if (Settings.get("filterLinkHints")) {
      for (const hint of nonOverlappingHints) {
        Object.assign(hint, this.generateLinkText(hint));
      }
    }
    return nonOverlappingHints;
  },

  generateLinkText(hint) {
    const element = hint.element;
    let linkText = "";
    let showLinkText = false;
    // toLowerCase is necessary as html documents return "IMG" and xhtml documents return "img"
    const nodeName = element.nodeName.toLowerCase();

    if (nodeName === "input") {
      if ((element.labels != null) && (element.labels.length > 0)) {
        linkText = element.labels[0].textContent.trim();
        // Remove trailing ":" commonly found in labels.
        if (linkText[linkText.length - 1] === ":") {
          linkText = linkText.slice(0, linkText.length - 1);
        }
        showLinkText = true;
      } else if ((element.getAttribute("type") || "").toLowerCase() === "file") {
        linkText = "Choose File";
      } else if (element.type !== "password") {
        linkText = element.value;
        if (!linkText && "placeholder" in element) {
          linkText = element.placeholder;
        }
      }
      // Check if there is an image embedded in the <a> tag.
    } else if (
      (nodeName === "a") && !element.textContent.trim() &&
      element.firstElementChild &&
      (element.firstElementChild.nodeName.toLowerCase() === "img")
    ) {
      linkText = element.firstElementChild.alt || element.firstElementChild.title;
      if (linkText) {
        showLinkText = true;
      }
    } else if (hint.reason != null) {
      linkText = hint.reason;
      showLinkText = true;
    } else if (element.textContent.length > 0) {
      linkText = element.textContent.slice(0, 256);
    } else if (element.hasAttribute("title")) {
      linkText = element.getAttribute("title");
    } else {
      linkText = element.innerHTML.slice(0, 256);
    }

    return { linkText: linkText.trim(), showLinkText };
  },
};

class HoverMode extends Mode {
  constructor(link) {
    super();
    super.init({ name: "hover-mode", singleton: "hover-mode", exitOnEscape: true });
    this.link = link;
    DomUtils.simulateHover(this.link);
    this.onExit(() => DomUtils.simulateUnhover(this.link));
  }
}



  // activatedElement is different from document.activeElement -- the latter seems to be reserved
// mostly for input elements. This mechanism allows us to decide whether to scroll a div or to
// scroll the whole document.
let activatedElement = null;

// Previously, the main scrolling element was document.body. If the "experimental web platform
// features" flag is enabled, then we need to use document.scrollingElement instead. There's an
// explanation in #2168: https://github.com/philc/vimium/pull/2168#issuecomment-236488091

const getScrollingElement = () =>
  getSpecialScrollingElement() || document.scrollingElement || document.body;

// Return 0, -1 or 1: the sign of the argument.
// NOTE(smblott; 2014/12/17) We would like to use Math.sign(). However, according to this site
// (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/sign)
// Math.sign() was only introduced in Chrome 38. This caused problems in R1.48 for users with old
// Chrome installations. We can replace this with Math.sign() at some point.
// TODO(philc): 2020-04-28: now we can make this replacement.
const getSign = function (val) {
  if (!val) {
    return 0;
  } else {
    if (val < 0) {
      return -1;
    } else {
      return 1;
    }
  }
};

const scrollProperties = {
  x: {
    axisName: "scrollLeft",
    max: "scrollWidth",
    viewSize: "clientWidth",
  },
  y: {
    axisName: "scrollTop",
    max: "scrollHeight",
    viewSize: "clientHeight",
  },
};

// Translate a scroll request into a number (which will be interpreted by `scrollBy` as a relative
// amount, or by `scrollTo` as an absolute amount). :direction must be "x" or "y". :amount may be
// either a number (in which case it is simply returned) or a string. If :amount is a string, then
// it is either "max" (meaning the height or width of element), or "viewSize". In both cases, we
// look up and return the requested amount, either in `element` or in `window`, as appropriate.
const getDimension = function (el, direction, amount) {
  if (Utils.isString(amount)) {
    const name = amount;
    // the clientSizes of the body are the dimensions of the entire page, but the viewport should
    // only be the part visible through the window
    if ((name === "viewSize") && (el === getScrollingElement())) {
      // TODO(smblott) Should we not be returning the width/height of element, here?
      return (direction === "x") ? globalThis.innerWidth : globalThis.innerHeight;
    } else {
      return el[scrollProperties[direction][name]];
    }
  } else {
    return amount;
  }
};

// Perform a scroll. Return true if we successfully scrolled by any amount, and false otherwise.
const performScroll = function (element, direction, amount) {
  const axisName = scrollProperties[direction].axisName;
  const before = element[axisName];
  if (element.scrollBy) {
    const scrollArg = { behavior: "instant" };
    scrollArg[direction === "x" ? "left" : "top"] = amount;
    element.scrollBy(scrollArg);
  } else {
    element[axisName] += amount;
  }
  return element[axisName] !== before;
};

// Test whether `element` should be scrolled. E.g. hidden elements should not be scrolled.
const shouldScroll = function (element, direction) {
  const computedStyle = globalThis.getComputedStyle(element);
  // Elements with `overflow: hidden` must not be scrolled.
  if (computedStyle.getPropertyValue(`overflow-${direction}`) === "hidden") {
    return false;
  }
  // Elements which are not visible should not be scrolled.
  if (["hidden", "collapse"].includes(computedStyle.getPropertyValue("visibility"))) {
    return false;
  }
  if (computedStyle.getPropertyValue("display") === "none") {
    return false;
  }
  return true;
};

// Test whether element does actually scroll in the direction required when asked to do so. Due to
// chrome bug 110149, scrollHeight and clientHeight cannot be used to reliably determine whether an
// element will scroll. Instead, we scroll the element by 1 or -1 and see if it moved (then put it
// back). :factor is the factor by which :scrollBy and :scrollTo will later scale the scroll amount.
// :factor can be negative, so we need it here in order to decide whether we should test a forward
// scroll or a backward scroll.
// Bug last verified in Chrome 38.0.2125.104.
const doesScroll = function (element, direction, amount, factor) {
  // amount is treated as a relative amount, which is correct for relative scrolls. For absolute
  // scrolls (only gg, G, and friends), amount can be either a string ("max" or "viewSize") or zero.
  // In the former case, we're definitely scrolling forwards, so any positive value will do for
  // delta. In the latter, we're definitely scrolling backwards, so a delta of -1 will do. For
  // absolute scrolls, factor is always 1.
  let delta = (factor * getDimension(element, direction, amount)) || -1;
  delta = getSign(delta); // 1 or -1
  return performScroll(element, direction, delta) && performScroll(element, direction, -delta);
};

const isScrollableElement = function (element, direction, amount, factor) {
  if (direction == null) {
    direction = "y";
  }
  if (amount == null) {
    amount = 1;
  }
  if (factor == null) {
    factor = 1;
  }
  return doesScroll(element, direction, amount, factor) && shouldScroll(element, direction);
};

// From element and its parents, find the first which we should scroll and which does scroll.
const findScrollableElement = function (element, direction, amount, factor) {
  while (
    (element !== getScrollingElement()) && !isScrollableElement(element, direction, amount, factor)
  ) {
    element = DomUtils.getContainingElement(element) || getScrollingElement();
  }
  return element;
};

// On some pages, the scrolling element is not actually scrollable. Here, we search the document for
// the largest visible element which does scroll vertically. This is used to initialize
// activatedElement. See #1358.
const firstScrollableElement = function (element = null) {
  let child;
  if (!element) {
    const scrollingElement = getScrollingElement();
    if (doesScroll(scrollingElement, "y", 1, 1) || doesScroll(scrollingElement, "y", -1, 1)) {
      return scrollingElement;
    } else {
      element = document.body || getScrollingElement();
    }
  }

  if (doesScroll(element, "y", 1, 1) || doesScroll(element, "y", -1, 1)) {
    return element;
  } else {
    // children = children.filter (c) -> c.rect # Filter out non-visible elements.
    const children = Array.from(element.children)
      .map((c) => ({ "element": c, "rect": DomUtils.getVisibleClientRect(c) }))
      .filter((child) => child.rect); // Filter out non-visible elements.
    children.map((child) => child.area = child.rect.width * child.rect.height);
    // Largest to smallest by visible area.
    for (child of children.sort((a, b) => b.area - a.area)) {
      const el = firstScrollableElement(child.element);
      if (el) {
        return el;
      }
    }
    return null;
  }
};

const checkVisibility = function (element) {
  // If the activated element has been scrolled completely offscreen, then subsequent changes in its
  // scroll position will not provide any more visual feedback to the user. Therefore, we deactivate
  // it so that subsequent scrolls affect the parent element.
  const rect = activatedElement.getBoundingClientRect();
  if (
    (rect.bottom < 0) || (rect.top > globalThis.innerHeight) || (rect.right < 0) ||
    (rect.left > globalThis.innerWidth)
  ) {
    return activatedElement = element;
  }
};

// How scrolling is handled by CoreScroller.
//   - For jump scrolling, the entire scroll happens immediately.
//   - For smooth scrolling with distinct key presses, a separate animator is initiated for each key
//     press. Therefore, several animators may be active at the same time. This ensures that two
//     quick taps on `j` scroll to the same position as two slower taps.
//   - For smooth scrolling with keyboard repeat (continuous scrolling), the most recently-activated
//     animator continues scrolling at least until its keyup event is received. We never initiate a
//     new animator on keyboard repeat.

// CoreScroller contains the core function (scroll) and logic for relative scrolls. All scrolls are
// ultimately translated to relative scrolls. CoreScroller is not exported.
const CoreScroller = {
  init() {
    this.time = 0;
    this.lastEvent = this.keyDownKey = null;
    this.installCancelEventListener();
  },

  // This installs listeners for events which should cancel smooth scrolling.
  installCancelEventListener() {
    // NOTE(smblott) With extreme keyboard configurations, Chrome sometimes does not get a keyup
    // event for every keydown, in which case tapping "j" scrolls indefinitely. This appears to be a
    // Chrome/OS/XOrg bug of some kind. See #1549.
    // TODO(philc): I believe some of these returns are unnecessary.
    return handlerStack.push({
      _name: "scroller/track-key-status",
      keydown: (event) => {
        return handlerStack.alwaysContinueBubbling(() => {
          this.keyDownKey = event.code;
          if (!event.repeat) {
            this.time += 1;
          }
          this.lastEvent = event;
        });
      },
      keyup: (event) => {
        return handlerStack.alwaysContinueBubbling(() => {
          if (event.code === this.keyDownKey) {
            this.keyDownKey = null;
            this.time += 1;
          }
        });
      },
      blur: (event) => {
        return handlerStack.alwaysContinueBubbling(() => {
          if (event.target === window) {
            this.time += 1;
          }
        });
      },
    });
  },

  // Return true if CoreScroller would not initiate a new scroll right now.
  wouldNotInitiateScroll() {
    return this.lastEvent && this.lastEvent.repeat && Settings.get("smoothScroll");
  },

  // Calibration fudge factors for continuous scrolling. The calibration value starts at 1.0. We
  // then increase it (until it exceeds @maxCalibration) if we guess that the scroll is too slow, or
  // decrease it (until it is less than @minCalibration) if we guess that the scroll is too fast.
  // The cutoff point for which guess we make is @calibrationBoundary. We require: 0
  // < @minCalibration <= 1 <= @maxCalibration.
  // Controls how much we're willing to slow scrolls down; smaller means more slow down.
  minCalibration: 0.5,
  // Controls how much we're willing to speed scrolls up; bigger means more speed up.
  maxCalibration: 1.6,
  // Boundary between scrolls which are considered too slow, or too fast.
  calibrationBoundary: 150,

  // Scroll element by a relative amount (a number) in some direction.
  scroll(element, direction, amount, continuous) {
    if (continuous == null) {
      continuous = true;
    }
    if (!amount) {
      return;
    }

    if (!Settings.get("smoothScroll")) {
      // Jump scrolling.
      performScroll(element, direction, amount);
      checkVisibility(element);
      return;
    }

    // We don't activate new animators on keyboard repeats; rather, the most-recently activated
    // animator continues scrolling.
    if (this.lastEvent != null ? this.lastEvent.repeat : undefined) {
      return;
    }

    const activationTime = ++this.time;
    const myKeyIsStillDown = () => (this.time === activationTime) && this.keyDownKey != null;

    // Store amount's sign and make amount positive; the arithmetic is clearer when amount is
    // positive.
    const sign = getSign(amount);
    amount = Math.abs(amount);

    // Initial intended scroll duration (in ms). We allow a bit longer for longer scrolls.
    const duration = Math.max(100, 20 * Math.log(amount));

    let totalDelta = 0;
    let totalElapsed = 0.0;
    let calibration = 1.0;
    let previousTimestamp = null;
    const cancelEventListener = this.installCancelEventListener();

    const animate = (timestamp) => {
      if (previousTimestamp == null) {
        previousTimestamp = timestamp;
      }
      if (timestamp === previousTimestamp) {
        return requestAnimationFrame(animate);
      }

      // The elapsed time is typically about 16ms.
      const elapsed = timestamp - previousTimestamp;
      totalElapsed += elapsed;
      previousTimestamp = timestamp;

      // The constants in the duration calculation, above, are chosen to provide reasonable scroll
      // speeds for distinct keypresses. For continuous scrolls, some scrolls are too slow, and
      // others too fast. Here, we speed up the slower scrolls, and slow down the faster scrolls.
      if (
        myKeyIsStillDown() && (75 <= totalElapsed) &&
        (this.minCalibration <= calibration && calibration <= this.maxCalibration)
      ) {
        // Speed up slow scrolls.
        if ((1.05 * calibration * amount) < this.calibrationBoundary) {
          calibration *= 1.05;
        }
        // Slow down fast scrolls.
        if (this.calibrationBoundary < (0.95 * calibration * amount)) {
          calibration *= 0.95;
        }
      }

      // Calculate the initial delta, rounding up to ensure progress. Then, adjust delta to account
      // for the current scroll state.
      let delta = Math.ceil(amount * (elapsed / duration) * calibration);
      delta = myKeyIsStillDown() ? delta : Math.max(0, Math.min(delta, amount - totalDelta));

      if (delta && performScroll(element, direction, sign * delta)) {
        totalDelta += delta;
        return requestAnimationFrame(animate);
      } else {
        // We're done.
        handlerStack.remove(cancelEventListener);
        return checkVisibility(element);
      }
    };

    // If we've been asked not to be continuous, then we advance time, so the myKeyIsStillDown test
    // always fails.
    if (!continuous) {
      ++this.time;
    }

    // Start scrolling.
    requestAnimationFrame(animate);
  },
};

// Scroller contains the two main scroll functions which are used by clients.
const Scroller = {
  init() {
    const handler = { _name: "scroller/active-element" };
    // Only Chrome has a DOMActivate event. On Firefox, we must listen for click. See #3287.
    const eventName = Utils.isFirefox() ? "click" : "DOMActivate";
    handler[eventName] = (event) =>
      handlerStack.alwaysContinueBubbling(function () {
        // If event.path is present, the true event taget (potentially inside a Shadow DOM inside
        // event.target) can be found as its first element.
        // NOTE(mrmr1993): event.path has been renamed to event.deepPath in the spec, but this
        // change is not yet implemented by Chrome.
        const path = event.deepPath || event.path;
        return activatedElement = path ? path[0] : event.target;
      });
    handlerStack.push(handler);
    CoreScroller.init();
    this.reset();
  },

  reset() {
    activatedElement = null;
  },

  // scroll the active element in :direction by :amount * :factor.
  // :factor is needed because :amount can take on string values, which scrollBy converts to element
  // dimensions.
  scrollBy(direction, amount, factor, continuous) {
    // if this is called before domReady, just use the window scroll function
    if (factor == null) {
      factor = 1;
    }
    if (continuous == null) {
      continuous = true;
    }
    if (!getScrollingElement() && amount instanceof Number) {
      if (direction === "x") {
        globalThis.scrollBy(amount, 0);
      } else {
        globalThis.scrollBy(0, amount);
      }
      return;
    }

    if (!activatedElement) {
      activatedElement = (getScrollingElement() && firstScrollableElement()) ||
        getScrollingElement();
    }
    if (!activatedElement) {
      return;
    }

    // Avoid the expensive scroll calculation if it will not be used. This reduces costs during
    // smooth, continuous scrolls, and is just an optimization.
    if (!CoreScroller.wouldNotInitiateScroll()) {
      const element = findScrollableElement(activatedElement, direction, amount, factor);
      const elementAmount = factor * getDimension(element, direction, amount);
      return CoreScroller.scroll(element, direction, elementAmount, continuous);
    }
  },

  scrollTo(direction, pos) {
    if (!activatedElement) {
      activatedElement = (getScrollingElement() && firstScrollableElement()) ||
        getScrollingElement();
    }
    if (!activatedElement) {
      return;
    }

    const element = findScrollableElement(activatedElement, direction, pos, 1);
    const amount = getDimension(element, direction, pos) -
      element[scrollProperties[direction].axisName];
    return CoreScroller.scroll(element, direction, amount);
  },

  // Is element scrollable and not the activated element?
  isScrollableElement(element) {
    if (!activatedElement) {
      activatedElement = (getScrollingElement() && firstScrollableElement()) ||
        getScrollingElement();
    }
    return (element !== activatedElement) && isScrollableElement(element);
  },

  // Scroll the top, bottom, left and right of element into view. The is used by visual mode to
  // ensure the focus remains visible.
  scrollIntoView(element) {
    if (!activatedElement) {
      activatedElement = getScrollingElement() && firstScrollableElement();
    }
    const rects = element.getClientRects();
    const rect = rects ? rects[0] : undefined;
    if (rect) {
      // Scroll y axis.
      let amount;
      if (rect.bottom < 0) {
        amount = rect.bottom - Math.min(rect.height, globalThis.innerHeight);
        element = findScrollableElement(element, "y", amount, 1);
        CoreScroller.scroll(element, "y", amount, false);
      } else if (globalThis.innerHeight < rect.top) {
        amount = rect.top + Math.min(rect.height - globalThis.innerHeight, 0);
        element = findScrollableElement(element, "y", amount, 1);
        CoreScroller.scroll(element, "y", amount, false);
      }

      // Scroll x axis.
      if (rect.right < 0) {
        amount = rect.right - Math.min(rect.width, globalThis.innerWidth);
        element = findScrollableElement(element, "x", amount, 1);
        CoreScroller.scroll(element, "x", amount, false);
      } else if (globalThis.innerWidth < rect.left) {
        amount = rect.left + Math.min(rect.width - globalThis.innerWidth, 0);
        element = findScrollableElement(element, "x", amount, 1);
        CoreScroller.scroll(element, "x", amount, false);
      }
    }
  },
};

const getSpecialScrollingElement = function () {
  const selector = specialScrollingElementMap[globalThis.location.host];
  if (selector) {
    return document.querySelector(selector);
  }
};

const specialScrollingElementMap = {
  "twitter.com": "div.permalink-container div.permalink[role=main]",
  "reddit.com": "#overlayScrollContainer",
  "new.reddit.com": "#overlayScrollContainer",
  "www.reddit.com": "#overlayScrollContainer",
  "web.telegram.org": ".MessageList",
};


  const Marks = {
  previousPositionRegisters: ["`", "'"],
  localRegisters: {},
  currentRegistryEntry: null,
  mode: null,

  exit(continuation = null) {
    if (this.mode != null) {
      this.mode.exit();
    }
    this.mode = null;
    if (continuation) {
      return continuation(); // TODO(philc): Is this return necessary?
    }
  },

  // This returns the key which is used for storing mark locations in localStorage.
  getLocationKey(keyChar) {
    return `vimiumMark|${globalThis.location.href.split("#")[0]}|${keyChar}`;
  },

  getMarkString() {
    return JSON.stringify({
      scrollX: globalThis.scrollX,
      scrollY: globalThis.scrollY,
      hash: globalThis.location.hash,
    });
  },

  setPreviousPosition() {
    const markString = this.getMarkString();
    for (const reg of this.previousPositionRegisters) {
      this.localRegisters[reg] = markString;
    }
  },

  showMessage(message, keyChar) {
    HUD.show(`${message} \"${keyChar}\".`, 1000);
  },

  // If <Shift> is depressed, then it's a global mark, otherwise it's a local mark. This is
  // consistent vim's [A-Z] for global marks and [a-z] for local marks. However, it also admits
  // other non-Latin characters. The exceptions are "`" and "'", which are always considered local
  // marks. The "swap" command option inverts global and local marks.
  isGlobalMark(event, keyChar) {
    let shiftKey = event.shiftKey;
    if (this.currentRegistryEntry.options.swap) {
      shiftKey = !shiftKey;
    }
    return shiftKey && !this.previousPositionRegisters.includes(keyChar);
  },

  activateCreateMode(_count, { registryEntry }) {
    this.currentRegistryEntry = registryEntry;
    this.mode = new Mode();
    this.mode.init({
      name: "create-mark",
      indicator: "Create mark...",
      exitOnEscape: true,
      suppressAllKeyboardEvents: true,
      keydown: (event) => {
        if (KeyboardUtils.isPrintable(event)) {
          const keyChar = KeyboardUtils.getKeyChar(event);
          this.exit(() => {
            if (this.isGlobalMark(event, keyChar)) {
              // We record the current scroll position, but only if this is the top frame within the
              // tab. Otherwise, we'll fetch the scroll position of the top frame from the
              // background page later.
              let scrollX, scrollY;
              if (DomUtils.isTopFrame()) {
                [scrollX, scrollY] = [globalThis.scrollX, globalThis.scrollY];
              }
              chrome.runtime.sendMessage({
                handler: "createMark",
                markName: keyChar,
                scrollX,
                scrollY,
              }, () => this.showMessage("Created global mark", keyChar));
            } else {
              localStorage[this.getLocationKey(keyChar)] = this.getMarkString();
              this.showMessage("Created local mark", keyChar);
            }
          });
          return handlerStack.suppressEvent;
        }
      },
    });
  },

  activateGotoMode(_count, { registryEntry }) {
    this.currentRegistryEntry = registryEntry;
    this.mode = new Mode();
    this.mode.init({
      name: "goto-mark",
      indicator: "Go to mark...",
      exitOnEscape: true,
      suppressAllKeyboardEvents: true,
      keydown: (event) => {
        if (KeyboardUtils.isPrintable(event)) {
          this.exit(() => {
            const keyChar = KeyboardUtils.getKeyChar(event);
            if (this.isGlobalMark(event, keyChar)) {
              // This key must match @getLocationKey() in the back end.
              const key = `vimiumGlobalMark|${keyChar}`;
              chrome.storage.local.get(key, function (items) {
                if (key in items) {
                  chrome.runtime.sendMessage({ handler: "gotoMark", markName: keyChar });
                  HUD.show(`Jumped to global mark '${keyChar}'`, 1000);
                } else {
                  HUD.show(`Global mark not set '${keyChar}'`, 1000);
                }
              });
            } else {
              const markString = this.localRegisters[keyChar] != null
                ? this.localRegisters[keyChar]
                : localStorage[this.getLocationKey(keyChar)];
              if (markString != null) {
                this.setPreviousPosition();
                const position = JSON.parse(markString);
                if (position.hash && (position.scrollX === 0) && (position.scrollY === 0)) {
                  globalThis.location.hash = position.hash;
                } else {
                  globalThis.scrollTo(position.scrollX, position.scrollY);
                }
                this.showMessage("Jumped to local mark", keyChar);
              } else {
                this.showMessage("Local mark not set", keyChar);
              }
            }
          });
          return handlerStack.suppressEvent;
        }
      },
    });
  },
};


  class InsertMode extends Mode {
  constructor(options) {
    super();
    if (options == null) {
      options = {};
    }

    // There is one permanently-installed instance of InsertMode. It tracks focus changes and
    // activates/deactivates itself (by setting @insertModeLock) accordingly.
    this.permanent = options.permanent;

    // If truthy, then we were activated by the user (with "i").
    this.global = options.global;

    this.passNextKeyKeys = [];

    // This list of keys is parsed from the user's key mapping config by commands.js, and stored in
    // chrome.storage.session.
    chrome.storage.session.get("passNextKeyKeys").then((value) => {
      this.passNextKeyKeys = value.passNextKeyKeys || [];
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName != "local") {
        return;
      }
      if (changes.passNextKeyKeys == null) {
        return;
      }
      this.passNextKeyKeys = changes.passNextKeyKeys.newValue;
    });

    const handleKeyEvent = (event) => {
      if (!this.isActive(event)) {
        return this.continueBubbling;
      }

      // See comment here:
      // https://github.com/philc/vimium/commit/48c169bd5a61685bb4e67b1e76c939dbf360a658
      const activeElement = this.getActiveElement(event);
      if ((activeElement === document.body) && activeElement.isContentEditable) {
        return this.passEventToPage;
      }

      // Check for a pass-next-key key.
      const keyString = KeyboardUtils.getKeyCharString(event);
      if (this.passNextKeyKeys.includes(keyString)) {
        new PassNextKeyMode();
      } else if ((event.type === "keydown") && KeyboardUtils.isEscape(event)) {
        if (DomUtils.isFocusable(activeElement)) {
          activeElement.blur();
        }

        if (!this.permanent) {
          this.exit();
        }
      } else {
        return this.passEventToPage;
      }

      return this.suppressEvent;
    };

    const defaults = {
      name: "insert",
      indicator: !this.permanent && !Settings.get("hideHud") ? "Insert mode" : null,
      keypress: handleKeyEvent,
      keydown: handleKeyEvent,
    };

    super.init(Object.assign(defaults, options));

    // Only for tests. This gives us a hook to test the status of the permanently-installed
    // instance.
    if (this.permanent) {
      InsertMode.permanentInstance = this;
    }
  }

  isActive(event) {
    if (event === InsertMode.suppressedEvent) {
      return false;
    }
    if (this.global) {
      return true;
    }
    return DomUtils.isFocusable(this.getActiveElement(event));
  }

  getActiveElement(event) {
    let activeElement = document.activeElement;
    while (activeElement && activeElement.shadowRoot && activeElement.shadowRoot.activeElement) {
      activeElement = activeElement.shadowRoot.activeElement;
    }
    if ((!activeElement || activeElement === document.body) && event && typeof event.composedPath === "function") {
      const path = event.composedPath();
      if (path && path.length > 0 && path[0] instanceof Element && DomUtils.isFocusable(path[0])) {
        activeElement = path[0];
      }
    }
    return activeElement;
  }

  static suppressEvent(event) {
    return this.suppressedEvent = event;
  }
}

// This allows PostFindMode to suppress the permanently-installed InsertMode instance.
InsertMode.suppressedEvent = null;

// This implements the pasNexKey command.
class PassNextKeyMode extends Mode {
  constructor(count) {
    if (count == null) {
      count = 1;
    }
    super();
    let seenKeyDown = false;
    let keyDownCount = 0;

    super.init({
      name: "pass-next-key",
      indicator: "Pass next key.",
      // We exit on blur because, once we lose the focus, we can no longer track key events.
      exitOnBlur: globalThis,
      keypress: () => {
        return this.passEventToPage;
      },

      keydown: () => {
        seenKeyDown = true;
        keyDownCount += 1;
        return this.passEventToPage;
      },

      keyup: () => {
        if (seenKeyDown) {
          if (!(--keyDownCount > 0)) {
            if (!(--count > 0)) {
              this.exit();
            }
          }
        }
        return this.passEventToPage;
      },
    });
  }
}


  // NOTE(smblott). Ultimately, all of the FindMode-related code should be moved here.

// This prevents unmapped printable characters from being passed through to underlying page; see
// #1415. Only used by PostFindMode, below.
class SuppressPrintable extends Mode {
  constructor(options) {
    super();
    super.init(options);
    const handler = (event) =>
      KeyboardUtils.isPrintable(event) ? this.suppressEvent : this.continueBubbling;
    const initialType = globalThis.getSelection().type;

    // We use unshift here, so we see events after normal mode, so we only see unmapped keys.
    this.unshift({
      _name: `mode-${this.id}/suppress-printable`,
      keydown: handler,
      keypress: handler,
      keyup: () => {
        // If the selection type has changed (usually, no longer "Range"), then the user is
        // interacting with the input element, so we get out of the way. See discussion of option 5c
        // from #1415.
        if (globalThis.getSelection().type !== initialType) {
          return this.exit();
        }
      },
    });
  }
}

// When we use find, the selection/focus can land in a focusable/editable element. In this
// situation, special considerations apply. We implement three special cases:
//   1. Disable insert mode, because the user hasn't asked to enter insert mode. We do this by using
//      InsertMode.suppressEvent.
//   2. Prevent unmapped printable keyboard events from propagating to the page; see #1415. We do
//      this by inheriting from SuppressPrintable.
//   3. If the very-next keystroke is Escape, then drop immediately into insert mode.
//
const newPostFindMode = function () {
  if (!document.activeElement || !DomUtils.isEditable(document.activeElement)) {
    return;
  }
  return new PostFindMode();
};

class PostFindMode extends SuppressPrintable {
  constructor() {
    const element = document.activeElement;
    super({
      name: "post-find",
      // PostFindMode shares a singleton with focusInput; each displaces the other.
      singleton: "post-find-mode/focus-input",
      exitOnBlur: element,
      exitOnClick: true,
      // Always truthy, so always continues bubbling.
      keydown(event) {
        return InsertMode.suppressEvent(event);
      },
      keypress(event) {
        return InsertMode.suppressEvent(event);
      },
      keyup(event) {
        return InsertMode.suppressEvent(event);
      },
    });

    // If the very-next keydown is Escape, then exit immediately, thereby passing subsequent keys to
    // the underlying insert-mode instance.
    this.push({
      _name: `mode-${this.id}/handle-escape`,
      keydown: (event) => {
        if (KeyboardUtils.isEscape(event)) {
          this.exit();
          return this.suppressEvent;
        } else {
          handlerStack.remove();
          return this.continueBubbling;
        }
      },
    });
  }
}

class FindMode extends Mode {
  constructor(options) {
    super();

    if (options == null) {
      options = {};
    }

    // TODO(philc): I don't think this.query is ever used/accessed, because it's only accessed from
    // static methods. Consider splitting the static portions of this class into a separate class
    // called FindModeSingleton. Blending the two together is confusing.
    this.query = {
      rawQuery: "",
      parsedQuery: "",
      matchCount: 0,
      hasResults: false,
    };

    // Save the selection, so findInPlace can restore it.
    this.initialRange = getCurrentRange();
    FindMode.query = { rawQuery: "" };

    if (options.returnToViewport) {
      this.scrollX = globalThis.scrollX;
      this.scrollY = globalThis.scrollY;
    }

    super.init(Object.assign(options, {
      name: "find",
      indicator: false,
      exitOnClick: true,
      exitOnEscape: true,
      // This prevents further Vimium commands launching before the find-mode HUD receives the
      // focus. E.g. "/" followed quickly by "i" should not leave us in insert mode.
      suppressAllKeyboardEvents: true,
    }));

    HUD.showFindMode(this);
  }

  exit(event) {
    HUD.unfocusIfFocused();
    super.exit();
    if (event) {
      FindMode.handleEscape();
    }
  }

  restoreSelection() {
    if (!this.initialRange) {
      return;
    }
    const range = this.initialRange;
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  findInPlace(query, options) {
    // If requested, restore the scroll position (so that failed searches leave the scroll position
    // unchanged).
    this.checkReturnToViewPort();
    FindMode.updateQuery(query);
    // Restore the selection. That way, we're always searching forward from the same place, so we
    // find the right match as the user adds matching characters, or removes previously-matched
    // characters. See #1434.
    this.restoreSelection();
    query = FindMode.query.isRegex
      ? FindMode.getQueryFromRegexMatches()
      : FindMode.query.parsedQuery;
    FindMode.query.hasResults = FindMode.execute(query, options);
  }

  static updateQuery(query) {
    let pattern;
    if (!this.query) {
      this.query = {};
    }
    this.query.rawQuery = query;
    // the query can be treated differently (e.g. as a plain string versus regex) depending on the
    // presence of escape sequences. '\' is the escape character and needs to be escaped itself to
    // be used as a normal character. here we grep for the relevant escape sequences.
    this.query.isRegex = Settings.get("regexFindMode");
    this.query.parsedQuery = this.query.rawQuery.replace(
      /(\\{1,2})([rRI]?)/g,
      (match, slashes, flag) => {
        if ((flag === "") || (slashes.length !== 1)) {
          return match;
        }

        switch (flag) {
          case "r":
            this.query.isRegex = true;
            break;
          case "R":
            this.query.isRegex = false;
            break;
        }
        return "";
      },
    );

    // Implement smartcase.
    this.query.ignoreCase = !Utils.hasUpperCase(this.query.parsedQuery);

    const regexPattern = this.query.isRegex
      ? this.query.parsedQuery
      : Utils.escapeRegexSpecialCharacters(this.query.parsedQuery);

    // Grep for all matches in every text node,
    // so we can show a the number of results.
    try {
      pattern = new RegExp(regexPattern, `g${this.query.ignoreCase ? "i" : ""}`);
    } catch {
      // If we catch a SyntaxError, assume the user is not done typing yet and return quietly.
      return;
    }

    const textNodes = getAllTextNodes();
    const matchedNodes = textNodes.filter((node) => {
      return node.textContent.match(pattern);
    });
    const regexMatches = matchedNodes.map((node) => node.textContent.match(pattern));
    this.query.regexMatches = regexMatches;
    this.query.regexPattern = pattern;
    this.query.regexMatchedNodes = matchedNodes;
    this.updateActiveRegexIndices();

    return this.query.matchCount = regexMatches != null ? regexMatches.flat().length : null;
  }

  // set activeRegexIndices near the latest selection
  static updateActiveRegexIndices() {
    let activeNodeIndex = -1;
    const matchedNodes = this.query.regexMatchedNodes;
    const selection = globalThis.getSelection();
    if (selection.rangeCount > 0) {
      activeNodeIndex = matchedNodes.indexOf(selection.anchorNode);

      if (activeNodeIndex === -1) {
        activeNodeIndex = this.query.regexMatchedNodes.findIndex((node) => {
          const range = selection.getRangeAt(0);

          if (range) {
            const sourceRange = document.createRange();
            sourceRange.setStart(node, 0);
            return range.compareBoundaryPoints(Range.START_TO_START, sourceRange) <= 0;
          } else {
            return false;
          }
        });
      }
    }
    this.query.activeRegexIndices = [Math.max(activeNodeIndex, 0), 0];
  }

  static getQueryFromRegexMatches() {
    // find()ing an empty query always returns false
    if (!this.query.regexMatches?.length) {
      return "";
    }
    const [row, col] = this.query.activeRegexIndices;
    return this.query.regexMatches[row][col];
  }

  static getNextQueryFromRegexMatches(backwards) {
    // find()ing an empty query always returns false
    if (!this.query.regexMatches?.length) {
      return "";
    }
    const stepSize = backwards ? -1 : 1;

    let [row, col] = this.query.activeRegexIndices;
    const numRows = this.query.regexMatches.length;
    col += stepSize;
    while (col < 0 || col >= this.query.regexMatches[row].length) {
      if (col < 0) {
        row += numRows - 1;
        row %= numRows;
        col += this.query.regexMatches[row].length;
      } else {
        col -= this.query.regexMatches[row].length;
        row += 1;
        row %= numRows;
      }
    }
    this.query.activeRegexIndices = [row, col];

    return this.query.regexMatches[row][col];
  }

  // Returns null if no search has been performed yet.
  static getQuery(backwards) {
    if (!this.query) {
      return;
    }
    // check if the query has been changed by a script in another frame
    const mostRecentQuery = FindModeHistory.getQuery();
    if (mostRecentQuery !== this.query.rawQuery) {
      this.updateQuery(mostRecentQuery);
    }

    return this.getNextQueryFromRegexMatches(backwards);
  }

  static saveQuery() {
    FindModeHistory.saveQuery(this.query.rawQuery);
  }

  // :options is an optional dict. valid parameters are 'caseSensitive' and 'backwards'.
  static execute(query, options) {
    let result = null;
    options = Object.assign({
      backwards: false,
      caseSensitive: !this.query.ignoreCase,
      colorSelection: true,
    }, options);
    if (query == null) {
      query = FindMode.getQuery(options.backwards);
    }

    if (options.colorSelection) {
      document.body.classList.add("vimium-find-mode");
      // ignore the selectionchange event generated by find()
      document.removeEventListener("selectionchange", this.restoreDefaultSelectionHighlight, true);
    }

    if (this.query.regexMatches?.length) {
      const [row, col] = this.query.activeRegexIndices;
      const node = this.query.regexMatchedNodes[row];
      const text = node.textContent;
      const matchIndices = getRegexMatchIndices(text, this.query.regexPattern);
      if (matchIndices.length > 0) {
        const startIndex = matchIndices[col];
        result = highlight(node, startIndex, query.length);
      }
    }

    // window.find focuses the |window| that it is called on. This gives us an opportunity to
    // (re-)focus another element/window, if that isn't the behaviour we want.
    if (options.postFindFocus != null) {
      options.postFindFocus.focus();
    }

    if (options.colorSelection) {
      setTimeout(
        () =>
          document.addEventListener("selectionchange", this.restoreDefaultSelectionHighlight, true),
        0,
      );
    }

    // We are either in normal mode ("n"), or find mode ("/"). We are not in insert mode.
    // Nevertheless, if a previous find landed in an editable element, then that element may still
    // be activated. In this case, we don't want to leave it behind (see #1412).
    if (document.activeElement && DomUtils.isEditable(document.activeElement)) {
      if (!DomUtils.isSelected(document.activeElement)) {
        document.activeElement.blur();
      }
    }

    return result;
  }

  // The user has found what they're looking for and is finished searching. We enter insert mode, if
  // possible.
  static handleEscape() {
    document.body.classList.remove("vimium-find-mode");
    // Removing the class does not re-color existing selections. we recreate the current selection
    // so it reverts back to the default color.
    const selection = globalThis.getSelection();
    if (!selection.isCollapsed) {
      const range = globalThis.getSelection().getRangeAt(0);
      globalThis.getSelection().removeAllRanges();
      globalThis.getSelection().addRange(range);
    }
    return focusFoundLink() || selectFoundInputElement();
  }

  // Save the query so the user can do further searches with it.
  static handleEnter() {
    focusFoundLink();
    document.body.classList.add("vimium-find-mode");
    return FindMode.saveQuery();
  }

  static findNext(backwards) {
    // Bail out if we don't have any query text.
    const nextQuery = FindMode.getQuery(backwards);
    if (!nextQuery) {
      HUD.show("No query to find.", 1000);
      return;
    }

    Marks.setPreviousPosition();
    FindMode.query.hasResults = FindMode.execute(nextQuery, { backwards });

    if (FindMode.query.hasResults) {
      focusFoundLink();
      return newPostFindMode();
    } else {
      return HUD.show(`No matches for '${FindMode.query.rawQuery}'`, 1000);
    }
  }

  checkReturnToViewPort() {
    if (this.options.returnToViewport) {
      globalThis.scrollTo(this.scrollX, this.scrollY);
    }
  }
}

FindMode.restoreDefaultSelectionHighlight = forTrusted(() =>
  document.body.classList.remove("vimium-find-mode")
);

const getCurrentRange = function () {
  const selection = getSelection();
  if (selection.type === "None") {
    const range = document.createRange();
    range.setStart(document.body, 0);
    range.setEnd(document.body, 0);
    return range;
  }

  if (selection.type === "Range") {
    selection.collapseToStart();
  }

  return selection.getRangeAt(0);
};

const getLinkFromSelection = function () {
  let node = globalThis.getSelection().anchorNode;
  while (node && (node !== document.body)) {
    if (node.nodeName.toLowerCase() === "a") {
      return node;
    }
    node = node.parentNode;
  }
  return null;
};

const focusFoundLink = function () {
  if (FindMode.query.hasResults) {
    const link = getLinkFromSelection();
    if (link) {
      link.focus();
    }
  }
};

const selectFoundInputElement = function () {
  // Since the last focused element might not be the one currently pointed to by find (e.g. the
  // current one might be disabled and therefore unable to receive focus), we use the approximate
  // heuristic of checking that the last anchor node is an ancestor of our element.
  const findModeAnchorNode = document.getSelection().anchorNode;
  if (
    FindMode.query.hasResults && document.activeElement &&
    DomUtils.isSelectable(document.activeElement) &&
    DomUtils.isDOMDescendant(findModeAnchorNode, document.activeElement)
  ) {
    return DomUtils.simulateSelect(document.activeElement);
  }
};

// Retrieve the starting indices of all matches of the queried pattern within the given text.
const getRegexMatchIndices = (text, regex) => {
  const indices = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (!match[0]) {
      break;
    }
    indices.push(match.index);
  }

  return indices;
};

// Highlights text starting from the given startIndex with the specified length.
const highlight = (textNode, startIndex, length) => {
  if (startIndex === -1) {
    return false;
  }
  const selection = globalThis.getSelection();
  const range = document.createRange();
  range.setStart(textNode, startIndex);
  range.setEnd(textNode, startIndex + length);
  selection.removeAllRanges();
  selection.addRange(range);

  // Ensure the highlighted element is visible within the viewport.
  const rect = range.getBoundingClientRect();
  if (rect.top < 0 || rect.bottom > globalThis.innerHeight) {
    const screenHeight = globalThis.innerHeight;
    globalThis.scrollTo({
      top: globalThis.scrollY + rect.top + rect.height / 2 - screenHeight / 2,
      // Scroll instantly when we find a search result. This matches the behavior of Chrome and
      // Firefox's native search UI. See #4661.
      behavior: "instant",
    });
  }

  return true;
};

const getAllTextNodes = () => {
  const textNodes = [];

  function getAllTextNodes(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      textNodes.push(node);
    } else if (
      node.nodeType === Node.ELEMENT_NODE &&
      (node.checkVisibility() || node.style.display === "contents")
    ) {
      const children = node.childNodes;
      for (const child of children) {
        getAllTextNodes(child, textNodes);
      }
    }
  }

  getAllTextNodes(document.body);
  return textNodes;
};


  // Example key mapping (@keyMapping):
//   i:
//     # This is a registryEntry object (as too are the other commands).
//     command: "enterInsertMode", ...
//   g:
//     g:
//       command: "scrollToTop", ...
//     t:
//       command: "nextTab", ...
//
// This key-mapping structure is generated by Commands.installKeyStateMapping and may be
// arbitrarily deep. Observe that @keyMapping["g"] is itself also a valid key mapping. At any point,
// the key state (@keyState) consists of a (non-empty) list of such mappings.

class KeyHandlerMode extends Mode {
  setKeyMapping(keyMapping) {
    this.keyMapping = keyMapping;
    this.reset();
  }
  setPassKeys(passKeys) {
    this.passKeys = passKeys;
    this.reset();
  }

  // Only for tests.
  setCommandHandler(commandHandler) {
    this.commandHandler = commandHandler;
  }

  // Reset the key state, optionally retaining the count provided.
  reset(countPrefix) {
    if (countPrefix == null) {
      countPrefix = 0;
    }
    this.countPrefix = countPrefix;
    this.keyState = [this.keyMapping];
  }

  init(options) {
    const args = Object.assign(options, { keydown: this.onKeydown.bind(this) });
    super.init(args);

    this.commandHandler = options.commandHandler || (function () {});
    this.setKeyMapping(options.keyMapping || {});

    if (options.exitOnEscape) {
      // If we're part way through a command's key sequence, then a first Escape should reset the
      // key state, and only a second Escape should actually exit this mode.
      this.push({
        _name: "key-handler-escape-listener",
        keydown: (event) => {
          if (KeyboardUtils.isEscape(event) && !this.isInResetState()) {
            this.reset();
            return this.suppressEvent;
          } else {
            return this.continueBubbling;
          }
        },
      });
    }
  }

  onKeydown(event) {
    const keyChar = KeyboardUtils.getKeyCharString(event);
    const isEscape = KeyboardUtils.isEscape(event);
    if (isEscape && ((this.countPrefix !== 0) || (this.keyState.length !== 1))) {
      return DomUtils.consumeKeyup(event, () => this.reset());
    } else if (isEscape && HelpDialog && HelpDialog.isShowing()) {
      // If the help dialog loses the focus, then Escape should hide it; see point 2 in #2045.
      HelpDialog.toggle();
      return this.suppressEvent;
    } else if (isEscape) {
      // Some links stay "open" after clicking, until you mouse off of them, like Wikipedia's link
      // preview popups. If the user types escape, issue a mouseout event here. See #3073.
      HintCoordinator.mouseOutOfLastClickedElement();
      return this.continueBubbling;
    } else if (this.countPrefix > 0 && keyChar === "0" && this.isCountKey(keyChar)) {
      const digit = 0;
      this.reset((this.countPrefix * 10) + digit);
      return this.suppressEvent;
    } else if (this.isMappedKey(keyChar)) {
      this.handleKeyChar(keyChar);
      return this.suppressEvent;
    } else if (this.isCountKey(keyChar)) {
      const digit = parseInt(keyChar);
      this.reset(this.keyState.length === 1 ? (this.countPrefix * 10) + digit : digit);
      return this.suppressEvent;
    } else {
      if (keyChar) {
        this.reset();
      }
      return this.continueBubbling;
    }
  }

  // This tests whether there is a mapping of keyChar in the current key state (and accounts for
  // pass keys).
  isMappedKey(keyChar) {
    // TODO(philc): tweak the generated js.
    return ((this.keyState.filter((mapping) => keyChar in mapping))[0] != null) &&
      !this.isPassKey(keyChar);
  }

  // This tests whether keyChar is a digit (and accounts for pass keys).
  isCountKey(keyChar) {
    return keyChar &&
      ((this.countPrefix > 0 ? "0" : "1") <= keyChar && keyChar <= "9") &&
      !this.isPassKey(keyChar);
  }

  // Keystrokes are *never* considered pass keys if the user has begun entering a command. So, for
  // example, if 't' is a passKey, then the "t"-s of 'gt' and '99t' are neverthless handled as
  // regular keys.
  isPassKey(keyChar) {
    // Find all *continuation* mappings for keyChar in the current key state (i.e. not the full key
    // mapping).
    const mappings = this.keyState.filter((mapping) =>
      keyChar in mapping && (mapping !== this.keyMapping)
    );
    // If there are no continuation mappings, and there's no count prefix, and keyChar is a pass
    // key, then it's a pass key.
    return mappings.length == 0 &&
      this.countPrefix == 0 &&
      this.passKeys &&
      this.passKeys.includes(keyChar);
  }

  isInResetState() {
    return (this.countPrefix === 0) && (this.keyState.length === 1);
  }

  handleKeyChar(keyChar) {
    // A count prefix applies only while keyChar is mapped in @keyState[0]; e.g. 7gj should be 1j.
    if (!(keyChar in this.keyState[0])) {
      this.countPrefix = 0;
    }

    // Advance the key state. The new state is the current mappings of keyChar, plus @keyMapping.
    const state = this.keyState.filter((mapping) => keyChar in mapping).map((mapping) =>
      mapping[keyChar]
    );
    state.push(this.keyMapping);
    this.keyState = state;

    if (this.keyState[0].command != null) {
      const command = this.keyState[0];
      const count = this.countPrefix > 0 ? this.countPrefix : null;
      this.reset();
      this.commandHandler({ command, count });
      if ((this.options.count != null) && (--this.options.count <= 0)) {
        this.exit();
      }
    }
    return this.suppressEvent;
  }
}


  // Symbolic names for some common strings.
const forward = "forward";
const backward = "backward";
const character = "character";
const word = "word";
const line = "line";
const sentence = "sentence";
const vimword = "vimword";
const lineboundary = "lineboundary";

// This implements various selection movements.
class Movement {
  constructor(alterMethod) {
    this.alterMethod = alterMethod;
    this.opposite = { forward: backward, backward: forward };
    this.selection = globalThis.getSelection();
  }

  // Return the character following (to the right of) the focus, and leave the selection unchanged,
  // or return undefined.
  getNextForwardCharacter() {
    const beforeText = this.selection.toString();
    if ((beforeText.length === 0) || (this.getDirection() === forward)) {
      this.selection.modify("extend", forward, character);
      const afterText = this.selection.toString();
      if (beforeText !== afterText) {
        this.selection.modify("extend", backward, character);
        return afterText[afterText.length - 1];
      }
    } else {
      return beforeText[0]; // The existing range selection is backwards.
    }
  }

  // Test whether the character after the focus is a word character (leaving the selection as is).
  nextCharacterIsWordCharacter() {
    // This regexp matches "word" characters.
    // From:
    // http://stackoverflow.com/questions/150033/regular-expression-to-match-non-english-characters.
    if (!this.regexp) {
      this.regexp =
        /[_0-9\u0041-\u005A\u0061-\u007A\u00AA\u00B5\u00BA\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u0527\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u08A0\u08A2-\u08AC\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0977\u0979-\u097F\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C33\u0C35-\u0C39\u0C3D\u0C58\u0C59\u0C60\u0C61\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D60\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F4\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191C\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19C1-\u19C7\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2183\u2184\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005\u3006\u3031-\u3035\u303B\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312D\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FCC\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA697\uA6A0-\uA6E5\uA717-\uA71F\uA722-\uA788\uA78B-\uA78E\uA790-\uA793\uA7A0-\uA7AA\uA7F8-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA80-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uABC0-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]/;
    }
    return this.regexp.test(this.getNextForwardCharacter());
  }

  // Run a movement. This is the core movement method, all movements happen here. For convenience,
  // the following three argument forms are supported:
  //   runMovement("forward word")
  //   runMovement(["forward", "word"])
  //   runMovement("forward", "word")
  //
  // The granularities are word, "character", "line", "lineboundary", "sentence" and "paragraph". In
  // addition, we implement the pseudo granularity "vimword", which implements vim-like word
  // movement (e.g. "w").
  //
  runMovement(...args) {
    // Normalize the various argument forms.
    const [direction, granularity] = (typeof (args[0]) === "string") && (args.length === 1)
      ? args[0].trim().split(/\s+/)
      : (args.length === 1 ? args[0] : args.slice(0, 2));

    // Native word movements behave differently on Linux and Windows, see #1441. So we implement
    // some of them character-by-character.
    if ((granularity === vimword) && (direction === forward)) {
      // Extend selection to the end of the 'vimword'.
      while (this.nextCharacterIsWordCharacter()) {
        if (this.extendByOneCharacter(forward) === 0) {
          return;
        }
      }
      // Extend selection after the 'vimword' to position before next word.
      while (this.getNextForwardCharacter() && !this.nextCharacterIsWordCharacter()) {
        if (this.extendByOneCharacter(forward) === 0) {
          return;
        }
      }
      // In Caret Mode collapse selection to the end.
      if (this.alterMethod === "move") {
        this.selection.collapseToEnd();
      }
      return;
    }

    // As above, we implement this character-by-character to get consistent behavior on Windows and
    // Linux.
    if ((granularity === word) && (direction === forward)) {
      // Extend selection to the start of the next 'word' (non-word characters, e.g. whitespace).
      while (this.getNextForwardCharacter() && !this.nextCharacterIsWordCharacter()) {
        if (this.extendByOneCharacter(forward) === 0) {
          return;
        }
      }
      // Extend selection to the end of the 'word'.
      while (this.nextCharacterIsWordCharacter()) {
        if (this.extendByOneCharacter(forward) === 0) {
          return;
        }
      }
      // In Caret Mode collapse selection to the end.
      if (this.alterMethod === "move") {
        this.selection.collapseToEnd();
      }
      return;
    } else {
      this.selection.modify(this.alterMethod, direction, granularity);
      return;
    }
  }

  // Swap the anchor node/offset and the focus node/offset. This allows us to work with both ends of
  // the selection, and implements "o" for visual mode.
  reverseSelection() {
    const direction = this.getDirection();
    const element = document.activeElement;
    if (element && DomUtils.isEditable(element) && !element.isContentEditable) {
      // Note(smblott). This implementation is expensive if the selection is large. We only use it
      // here because the normal method (below) does not work within text areas, etc.
      const length = this.selection.toString().length;
      this.collapseSelectionToFocus();
      for (let i = 0, end = length; i < end; i++) {
        this.runMovement(this.opposite[direction], character);
      }
    } else {
      // Normal method.
      const original = this.selection.getRangeAt(0).cloneRange();
      const range = original.cloneRange();
      range.collapse(direction === backward);
      this.setSelectionRange(range);
      const which = direction === forward ? "start" : "end";
      this.selection.extend(original[`${which}Container`], original[`${which}Offset`]);
    }
  }

  // Try to extend the selection by one character in direction. Return positive, negative or 0,
  // indicating whether the selection got bigger, or smaller, or is unchanged.
  extendByOneCharacter(direction) {
    const length = this.selection.toString().length;
    this.selection.modify("extend", direction, character);
    return this.selection.toString().length - length;
  }

  // Get the direction of the selection. The selection is "forward" if the focus is at or after the
  // anchor, and "backward" otherwise.
  // NOTE(smblott). This could be better, see: https://dom.spec.whatwg.org/#interface-range
  // (however, that probably wouldn't work for inputs).
  getDirection() {
    // Try to move the selection forward or backward, check whether it got bigger or smaller (then
    // restore it).
    for (const direction of [forward, backward]) {
      const change = this.extendByOneCharacter(direction);
      if (change) {
        this.extendByOneCharacter(this.opposite[direction]);
        if (change > 0) {
          return direction;
        } else {
          return this.opposite[direction];
        }
      }
    }
    return forward;
  }

  collapseSelectionToAnchor() {
    if (this.selection.toString().length == 0) {
      return;
    }
    if (this.getDirection() === backward) {
      this.selection.collapseToEnd();
    } else {
      this.selection.collapseToStart();
    }
  }

  collapseSelectionToFocus() {
    if (this.selection.toString().length == 0) {
      return;
    }
    if (this.getDirection() === forward) {
      this.selection.collapseToEnd();
    } else {
      this.selection.collapseToStart();
    }
  }

  setSelectionRange(range) {
    this.selection.removeAllRanges();
    // TODO(philc): Is this return needed?
    return this.selection.addRange(range);
  }

  // For "aw", "as". We don't do "ap" (for paragraphs), because Chrome paragraph movements are
  // weird.
  selectLexicalEntity(entity, count) {
    if (count == null) {
      count = 1;
    }
    this.collapseSelectionToFocus();
    // This makes word movements a bit more vim-like.
    if (entity === word) {
      this.runMovement([forward, character]);
    }
    this.runMovement([backward, entity]);
    this.collapseSelectionToFocus();
    for (let i = 0, end = count; i < end; i++) {
      this.runMovement([forward, entity]);
    }
  }

  selectLine(count) {
    // Even under caret mode, we still need an extended selection here.
    this.alterMethod = "extend";
    if (this.getDirection() === forward) {
      this.reverseSelection();
    }
    this.runMovement(backward, lineboundary);
    this.reverseSelection();
    for (let i = 1, end = count; i < end; i++) {
      this.runMovement(forward, line);
    }
    this.runMovement(forward, lineboundary);
    // Include the next character if that character is a newline.
    if (this.getNextForwardCharacter() === "\n") {
      return this.runMovement(forward, character);
    }
  }

  // Scroll the focus into view.
  scrollIntoView() {
    if (this.selection.type !== "None") {
      const elementWithFocus = DomUtils.getElementWithFocus(
        this.selection,
        this.getDirection() === backward,
      );
      if (elementWithFocus) {
        return Scroller.scrollIntoView(elementWithFocus);
      }
    }
  }
}

class VisualMode extends KeyHandlerMode {
  init(options) {
    let movement;
    if (options == null) {
      options = {};
    }
    this.movement = new Movement(options.alterMethod != null ? options.alterMethod : "extend");
    this.selection = this.movement.selection;

    // Build the key mapping structure required by KeyHandlerMode. This only handles one- and
    // two-key mappings.
    const keyMapping = {};
    for (const keys of Object.keys(this.movements || {})) {
      movement = this.movements[keys];
      if ("function" === typeof movement) {
        movement = movement.bind(this);
      }
      if (keys.length === 1) {
        keyMapping[keys] = { command: movement };
      } else { // keys.length == 2
        if (keyMapping[keys[0]] == null) {
          keyMapping[keys[0]] = {};
        }
        Object.assign(keyMapping[keys[0]], { [keys[1]]: { command: movement } });
      }
    }

    // Aliases and complex bindings.
    Object.assign(keyMapping, {
      "B": keyMapping.b,
      "W": keyMapping.w,
      "<c-e>": {
        command(count) {
          return Scroller.scrollBy("y", count * Settings.get("scrollStepSize"), 1, false);
        },
      },
      "<c-y>": {
        command(count) {
          return Scroller.scrollBy("y", -count * Settings.get("scrollStepSize"), 1, false);
        },
      },
    });

    super.init(Object.assign(options, {
      name: options.name != null ? options.name : "visual",
      indicator: options.indicator != null ? options.indicator : "Visual mode",
      // Visual mode, visual-line mode and caret mode each displace each other.
      singleton: "visual-mode-group",
      exitOnEscape: true,
      suppressAllKeyboardEvents: true,
      keyMapping,
      commandHandler: this.commandHandler.bind(this),
    }));

    // If there was a range selection when the user lanuched visual mode, then we retain the
    // selection on exit.
    this.shouldRetainSelectionOnExit = this.options.userLaunchedMode &&
      (this.selection.type === "Range");

    this.onExit((event = null) => {
      // Retain any selection, regardless of how we exit.
      if (this.shouldRetainSelectionOnExit) {
        // This mimics vim: when leaving visual mode via Escape, collapse to focus, otherwise
        // collapse to anchor.
      } else if (
        event && (event.type === "keydown") && KeyboardUtils.isEscape(event) &&
        (this.name !== "caret")
      ) {
        this.movement.collapseSelectionToFocus();
      } else {
        this.movement.collapseSelectionToAnchor();
      }

      // Don't leave the user in insert mode just because they happen to have selected an input.
      if (document.activeElement && DomUtils.isEditable(document.activeElement)) {
        if ((event != null ? event.type : undefined) !== "click") {
          return document.activeElement.blur();
        }
      }
    });

    this.push({
      _name: `${this.id}/enter/click`,
      // Yank on <Enter>.
      keypress: (event) => {
        if (event.key === "Enter") {
          if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
            this.yank();
            return this.suppressEvent;
          }
        }
        return this.continueBubbling;
      },
      // Click in a focusable element exits.
      click: (event) =>
        this.alwaysContinueBubbling(() => {
          if (DomUtils.isFocusable(event.target)) {
            return this.exit(event);
          }
        }),
    });

    // Establish or use the initial selection. If that's not possible, then enter caret mode.
    if (this.name !== "caret") {
      if (["Caret", "Range"].includes(this.selection.type)) {
        let selectionRect = this.selection.getRangeAt(0).getBoundingClientRect();
        if (globalThis.vimiumDomTestsAreRunning) {
          // We're running the DOM tests, where getBoundingClientRect() isn't available.
          if (!selectionRect) {
            selectionRect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
          }
        }
        selectionRect = Rect.intersect(
          selectionRect,
          Rect.create(0, 0, globalThis.innerWidth, globalThis.innerHeight),
        );
        if ((selectionRect.height >= 0) && (selectionRect.width >= 0)) {
          // The selection is visible in the current viewport.
          if (this.selection.type === "Caret") {
            // The caret is in the viewport. Make make it visible.
            this.movement.extendByOneCharacter(forward) ||
              this.movement.extendByOneCharacter(backward);
          }
        } else {
          // The selection is outside of the viewport: clear it. We guess that the user has moved
          // on, and is more likely to be interested in visible content.
          this.selection.removeAllRanges();
        }
      }

      if ((this.selection.type !== "Range") && (this.name !== "caret")) {
        new CaretMode().init();
        return HUD.show("No usable selection, entering caret mode...", 2500);
      }
    }
  }

  commandHandler({ command: { command }, count }) {
    if (count == null) {
      count = 1;
    }
    switch (typeof command) {
      case "string":
        for (let i = 0, end = count; i < end; i++) {
          this.movement.runMovement(command);
        }
        break;
      case "function":
        command(count);
        break;
    }
    return this.movement.scrollIntoView();
  }

  // find: (count, backwards) =>
  find(count, backwards) {
    const initialRange = this.selection.getRangeAt(0).cloneRange();
    for (let i = 0, end = count; i < end; i++) {
      const nextQuery = FindMode.getQuery(backwards);
      if (!nextQuery) {
        HUD.show("No query to find.", 1000);
        return;
      }
      if (!FindMode.execute(nextQuery, { colorSelection: false, backwards })) {
        this.movement.setSelectionRange(initialRange);
        HUD.show(`No matches for '${FindMode.query.rawQuery}'`, 1000);
        return;
      }
    }

    // The find was successfull. If we're in caret mode, then we should now have a selection, so we
    // can drop back into visual mode.
    if ((this.name === "caret") && (this.selection.toString().length > 0)) {
      const mode = new VisualMode();
      mode.init();
      return mode;
    }
  }

  // Yank the selection; always exits; collapses the selection; set @yankedText and return it.
  yank(args) {
    if (args == null) {
      args = {};
    }
    this.yankedText = this.selection.toString();
    this.exit();
    const copied = HUD.copyToClipboard(this.yankedText);
    if (copied !== false) {
      let message = this.yankedText.replace(/\s+/g, " ");
      if (15 < this.yankedText.length) {
        message = message.slice(0, 12) + "...";
      }
      const plural = this.yankedText.length === 1 ? "" : "s";
      HUD.show(`Yanked ${this.yankedText.length} character${plural}: "${message}".`, 2500);
    }

    return this.yankedText;
  }
}

// A movement can be either a string or a function.
VisualMode.prototype.movements = {
  "l": "forward character",
  "h": "backward character",
  "j": "forward line",
  "k": "backward line",
  "e": "forward word",
  "b": "backward word",
  "w": "forward vimword",
  ")": "forward sentence",
  "(": "backward sentence",
  "}": "forward paragraph",
  "{": "backward paragraph",
  "0": "backward lineboundary",
  "$": "forward lineboundary",
  "G": "forward documentboundary",
  "gg": "backward documentboundary",

  "aw"(count) {
    return this.movement.selectLexicalEntity(word, count);
  },
  "as"(count) {
    return this.movement.selectLexicalEntity(sentence, count);
  },

  "n"(count) {
    return this.find(count, false);
  },
  "N"(count) {
    return this.find(count, true);
  },
  "/"() {
    this.exit();
    return new FindMode({ returnToViewport: true }).onExit(() => new VisualMode().init());
  },

  "y"() {
    return this.yank();
  },
  "Y"(count) {
    this.movement.selectLine(count);
    return this.yank();
  },
  "p"() {
    return chrome.runtime.sendMessage({ handler: "openUrlInCurrentTab", url: this.yank() });
  },
  "P"() {
    return chrome.runtime.sendMessage({ handler: "openUrlInNewTab", url: this.yank() });
  },
  "v"() {
    return new VisualMode().init();
  },
  "V"() {
    return new VisualLineMode().init();
  },
  "c"() {
    // If we're already in caret mode, or if the selection looks the same as it would in caret mode,
    // then callapse to anchor (so that the caret-mode selection will seem unchanged). Otherwise,
    // we're in visual mode and the user has moved the focus, so collapse to that.
    if ((this.name === "caret") || (this.selection.toString().length <= 1)) {
      this.movement.collapseSelectionToAnchor();
    } else {
      this.movement.collapseSelectionToFocus();
    }
    return new CaretMode().init();
  },
  "o"() {
    return this.movement.reverseSelection();
  },
};

class VisualLineMode extends VisualMode {
  init(options) {
    if (options == null) {
      options = {};
    }
    super.init(Object.assign(options, { name: "visual/line", indicator: "Visual mode (line)" }));
    return this.extendSelection();
  }

  commandHandler({ command: { command }, count }) {
    if (count == null) {
      count = 1;
    }
    switch (typeof command) {
      case "string":
        for (let i = 0, end = count; i < end; i++) {
          this.movement.runMovement(command);
          // If the current selection
          //  * has only 1 line (the line selected when we enter the visual line mode), and
          //  * its direction is different from the command,
          // then the command will in effect unselect that line. In this case, we restore that line
          // and reverse its direction, keeping that line selected.
          if (this.selection.isCollapsed) {
            this.extendSelection();
            const [direction, granularity] = command.split(" ");
            if ((this.movement.getDirection() !== direction) && (granularity === "line")) {
              this.movement.reverseSelection();
            }
            this.movement.runMovement(command);
          }
        }
        break;
      case "function":
        command(count);
        break;
    }
    this.movement.scrollIntoView();
    if (this.modeIsActive) {
      return this.extendSelection();
    }
  }

  extendSelection() {
    const initialDirection = this.movement.getDirection();
    // TODO(philc): Reformat this to be a plain loop rather than a closure.
    return (() => {
      const result = [];
      for (const direction of [initialDirection, this.movement.opposite[initialDirection]]) {
        this.movement.runMovement(direction, lineboundary);
        result.push(this.movement.reverseSelection());
      }
      return result;
    })();
  }
}

class CaretMode extends VisualMode {
  init(options) {
    if (options == null) {
      options = {};
    }
    super.init(
      Object.assign(options, { name: "caret", indicator: "Caret mode", alterMethod: "move" }),
    );

    // Establish the initial caret.
    switch (this.selection.type) {
      case "None":
        this.establishInitialSelectionAnchor();
        if (this.selection.type === "None") {
          this.exit();
          HUD.show("Create a selection before entering visual mode.", 2500);
          return;
        }
        break;
      case "Range":
        this.movement.collapseSelectionToAnchor();
        break;
    }

    this.movement.extendByOneCharacter(forward);
    return this.movement.scrollIntoView();
  }

  commandHandler(...args) {
    this.movement.collapseSelectionToAnchor();
    super.commandHandler(...(args || []));
    if (this.modeIsActive) {
      return this.movement.extendByOneCharacter(forward);
    }
  }

  // When visual mode starts and there's no existing selection, we launch CaretMode and try to
  // establish a selection. As a heuristic, we pick the first non-whitespace character of the first
  // visible text node which seems to be big enough to be interesting.
  // TODO(smblott). It might be better to do something similar to Clearly or Readability; that is,
  // try to find the start of the page's main textual content.
  establishInitialSelectionAnchor() {
    let node;
    const nodes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while ((node = nodes.nextNode())) {
      // Don't choose short text nodes; they're likely to be part of a banner.
      if ((node.nodeType === 3) && (50 <= node.data.trim().length)) {
        const element = node.parentElement;
        if (DomUtils.getVisibleClientRect(element) && !DomUtils.isEditable(element)) {
          // Start at the offset of the first non-whitespace character.
          const offset = node.data.length - node.data.replace(/^\s+/, "").length;
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset);
          this.movement.setSelectionRange(range);
          return true;
        }
      }
    }
    return false;
  }
}


  class NormalMode extends KeyHandlerMode {
  init(options) {
    if (options == null) {
      options = {};
    }

    const defaults = {
      name: "normal",
      indicator: false, // There is normally no mode indicator in normal mode.
      commandHandler: this.commandHandler.bind(this),
    };

    super.init(Object.assign(defaults, options));

    chrome.storage.session.get(
      "normalModeKeyStateMapping",
      (items) => this.setKeyMapping(items.normalModeKeyStateMapping),
    );

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "session" && changes.normalModeKeyStateMapping?.newValue) {
        this.setKeyMapping(changes.normalModeKeyStateMapping.newValue);
      }
    });

    // Listen and handle "command" events coming from the background and originally sent from the
    // Vomnibar page.
    Utils.addChromeRuntimeOnMessageListener(["runNormalModeCommand"], (request, _sender) => {
      this.commandHandler(request);
    });
  }

  commandHandler({ command: registryEntry, count }) {
    if (registryEntry.command === "Vomnibar.activateCommandSelection") {
      // Store the raw count so the Vomnibar can propagate it to the selected command.
      registryEntry.options.prefixCount = count;
    }

    if (registryEntry.options.count) {
      count = (count ?? 1) * registryEntry.options.count;
    }

    // closeTabsOnLeft and closeTabsOnRight interpret a null count as "close all tabs in
    // {direction}", so don't default the count to 1 for those commands. See #4296.
    const allowNullCount = ["closeTabsOnLeft", "closeTabsOnRight"].includes(registryEntry.command);
    if (!allowNullCount && count == null) {
      count = 1;
    }

    if (registryEntry.noRepeat && count) {
      count = 1;
    }

    if ((registryEntry.repeatLimit != null) && (registryEntry.repeatLimit < count)) {
      const result = confirm(
        `You have asked Vimium to perform ${count} repetitions of the ` +
          `command "${registryEntry.command}". Are you sure you want to continue?`,
      );
      if (!result) {
        return;
      }
    }

    if (registryEntry.topFrame && DomUtils.isTopFrame()) {
      // We're already in the top frame, so run the command here rather than via the background
      // page. The round trip takes long enough that keys typed straight after a Vomnibar command
      // would reach normal mode before the Vomnibar starts buffering them.
      NormalModeCommands[registryEntry.command](frameId, registryEntry);
    } else if (registryEntry.topFrame) {
      // We never return to a UI-component frame (e.g. the help dialog), it might have lost the
      // focus.
      const sourceFrameId = globalThis.isVimiumUIComponent ? 0 : frameId;
      chrome.runtime.sendMessage({
        handler: "sendMessageToFrames",
        message: { handler: "runInTopFrame", sourceFrameId, registryEntry },
      });
    } else if (registryEntry.background) {
      chrome.runtime.sendMessage({ handler: "runBackgroundCommand", registryEntry, count });
    } else {
      const commandFn = NormalModeCommands[registryEntry.command];
      commandFn(count, { registryEntry });
    }
  }
}

const enterNormalMode = function (count) {
  const mode = new NormalMode();
  mode.init({
    indicator: "Normal mode (pass keys disabled)",
    exitOnEscape: true,
    singleton: "enterNormalMode",
    count,
  });
  return mode;
};

function findSelectedHelper(backwards) {
  const selection = globalThis.getSelection().toString();
  if (!selection) {
    return;
  }
  FindMode.updateQuery(selection);
  FindMode.saveQuery();
  FindMode.findNext(backwards);
}

const NormalModeCommands = {
  // Scrolling.
  scrollToBottom() {
    Marks.setPreviousPosition();
    Scroller.scrollTo("y", "max");
  },
  scrollToTop(count) {
    Marks.setPreviousPosition();
    Scroller.scrollTo("y", (count - 1) * Settings.get("scrollStepSize"));
  },
  scrollToLeft() {
    Scroller.scrollTo("x", 0);
  },
  scrollToRight() {
    Scroller.scrollTo("x", "max");
  },
  scrollUp(count) {
    Scroller.scrollBy("y", -1 * Settings.get("scrollStepSize") * count);
  },
  scrollDown(count) {
    Scroller.scrollBy("y", Settings.get("scrollStepSize") * count);
  },
  scrollPageUp(count) {
    Scroller.scrollBy("y", "viewSize", (-1 / 2) * count);
  },
  scrollPageDown(count) {
    Scroller.scrollBy("y", "viewSize", (1 / 2) * count);
  },
  scrollFullPageUp(count) {
    Scroller.scrollBy("y", "viewSize", -1 * count);
  },
  scrollFullPageDown(count) {
    Scroller.scrollBy("y", "viewSize", 1 * count);
  },
  scrollLeft(count) {
    Scroller.scrollBy("x", -1 * Settings.get("scrollStepSize") * count);
  },
  scrollRight(count) {
    Scroller.scrollBy("x", Settings.get("scrollStepSize") * count);
  },

  // Tab navigation: back, forward.
  goBack(count) {
    chrome.runtime.sendMessage({ handler: "runBackgroundCommand", registryEntry: { command: "goBack" }, count });
  },
  goForward(count) {
    chrome.runtime.sendMessage({ handler: "runBackgroundCommand", registryEntry: { command: "goForward" }, count });
  },

  // Url manipulation.
  goUp(count) {
    let url = globalThis.location.href;
    if (url.endsWith("/")) {
      url = url.substring(0, url.length - 1);
    }

    let urlsplit = url.split("/");
    // make sure we haven't hit the base domain yet
    if (urlsplit.length > 3) {
      urlsplit = urlsplit.slice(0, Math.max(3, urlsplit.length - count));
      globalThis.location.href = urlsplit.join("/");
    }
  },

  goToRoot() {
    globalThis.location.href = globalThis.location.origin;
  },

  toggleViewSource() {
    chrome.runtime.sendMessage({ handler: "getCurrentTabUrl" }, function (url) {
      if (url.substr(0, 12) === "view-source:") {
        url = url.substr(12, url.length - 12);
      } else {
        url = "view-source:" + url;
      }
      chrome.runtime.sendMessage({ handler: "openUrlInNewTab", url });
    });
  },

  copyCurrentUrl() {
    chrome.runtime.sendMessage({ handler: "getCurrentTabUrl" }, function (url) {
      HUD.copyToClipboard(url);
      // This length is determined empirically based on a 350px width of the HUD. An alternate
      // solution is to have the HUD ellipsize based on its width.
      const maxLength = 40;
      if (url.length > maxLength) {
        url = url.slice(0, maxLength - 2) + "...";
      }
      HUD.show(`Yanked ${url}`, 2000);
    });
  },

  openCopiedUrlInNewTab(count, request) {
    HUD.pasteFromClipboard((url) =>
      chrome.runtime.sendMessage({
        handler: "openUrlInNewTab",
        position: request.registryEntry.options.position,
        url,
        count,
      })
    );
  },

  openCopiedUrlInCurrentTab() {
    HUD.pasteFromClipboard((url) =>
      chrome.runtime.sendMessage({ handler: "openUrlInCurrentTab", url })
    );
  },

  // Mode changes.
  enterInsertMode() {
    // If a focusable element receives the focus, then we exit and leave the permanently-installed
    // insert-mode instance to take over.
    return new InsertMode({ global: true, exitOnFocus: true });
  },

  enterVisualMode() {
    const mode = new VisualMode();
    mode.init({ userLaunchedMode: true });
    return mode;
  },

  enterVisualLineMode() {
    const mode = new VisualLineMode();
    mode.init({ userLaunchedMode: true });
    return mode;
  },

  enterFindMode() {
    Marks.setPreviousPosition();
    return new FindMode();
  },

  // Find.
  performFind(count) {
    for (let i = 0, end = count; i < end; i++) {
      FindMode.findNext(false);
    }
  },

  performBackwardsFind(count) {
    for (let i = 0, end = count; i < end; i++) {
      FindMode.findNext(true);
    }
  },

  findSelected() {
    findSelectedHelper(false);
  },

  findSelectedBackwards() {
    findSelectedHelper(true);
  },

  // Misc.
  mainFrame() {
    return focusThisFrame({ highlight: true, forceFocusThisFrame: true });
  },
  showHelp(sourceFrameId) {
    return HelpDialog.toggle({ sourceFrameId });
  },

  passNextKey(count, options) {
    // TODO(philc): OK to remove return statement?
    if (options.registryEntry.options.normal) {
      return enterNormalMode(count);
    } else {
      return new PassNextKeyMode(count);
    }
  },

  goPrevious() {
    const previousPatterns = Settings.get("previousPatterns") || "";
    const previousStrings = previousPatterns.split(",").filter((s) => s.trim().length);
    const target = findElementWithRelValue("prev") || findLink(previousStrings);
    if (target) {
      followLink(target);
    }
  },

  goNext() {
    const nextPatterns = Settings.get("nextPatterns") || "";
    const nextStrings = nextPatterns.split(",").filter((s) => s.trim().length);
    const target = findElementWithRelValue("next") || findLink(nextStrings);
    if (target) {
      followLink(target);
    }
  },

  focusInput(count) {
    // Focus the first input element on the page, and create overlays to highlight all the input
    // elements, with the currently-focused element highlighted specially. Tabbing will shift focus
    // to the next input element. Pressing any other key will remove the overlays and the special
    // tab behavior.
    let element, selectedInputIndex;
    const resultSet = DomUtils.evaluateXPath(
      textInputXPath,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    );
    const visibleInputs = [];

    for (let i = 0, end = resultSet.snapshotLength; i < end; i++) {
      element = resultSet.snapshotItem(i);
      if (!DomUtils.getVisibleClientRect(element, true)) {
        continue;
      }
      visibleInputs.push({ element, index: i, rect: Rect.copy(element.getBoundingClientRect()) });
    }

    visibleInputs.sort(
      function ({ element: element1, index: i1 }, { element: element2, index: i2 }) {
        // Put elements with a lower positive tabIndex first, keeping elements in DOM order.
        if (element1.tabIndex > 0) {
          if (element2.tabIndex > 0) {
            const tabDifference = element1.tabIndex - element2.tabIndex;
            if (tabDifference !== 0) {
              return tabDifference;
            } else {
              return i1 - i2;
            }
          } else {
            return -1;
          }
        } else if (element2.tabIndex > 0) {
          return 1;
        } else {
          return i1 - i2;
        }
      },
    );

    if (visibleInputs.length === 0) {
      HUD.show("There are no inputs to focus.", 1000);
      return;
    }

    // This is a hack to improve usability on the Vimium options page. We prime the recently-focused
    // input to be the key-mappings input. Arguably, this is the input that the user is most likely
    // to use.
    const recentlyFocusedElement = lastFocusedInput();

    if (count === 1) {
      // As the starting index, we pick that of the most recently focused input element (or 0).
      const elements = visibleInputs.map((visibleInput) => visibleInput.element);
      selectedInputIndex = Math.max(0, elements.indexOf(recentlyFocusedElement));
    } else {
      selectedInputIndex = Math.min(count, visibleInputs.length) - 1;
    }

    const hints = visibleInputs.map((tuple) => {
      const hint = DomUtils.createElement("div");
      hint.className = "vimium-reset internal-vimium-input-hint vimiumInputHint";

      // minus 1 for the border
      hint.style.left = (tuple.rect.left - 1) + globalThis.scrollX + "px";
      hint.style.top = (tuple.rect.top - 1) + globalThis.scrollY + "px";
      hint.style.width = tuple.rect.width + "px";
      hint.style.height = tuple.rect.height + "px";

      return hint;
    });

    return new FocusSelector(hints, visibleInputs, selectedInputIndex);
  },

  "LinkHints.activateMode": LinkHints.activateMode.bind(LinkHints),
  "LinkHints.activateModeToOpenInNewTab": LinkHints.activateModeToOpenInNewTab.bind(LinkHints),
  "LinkHints.activateModeToOpenInNewForegroundTab": LinkHints.activateModeToOpenInNewForegroundTab
    .bind(LinkHints),
  "LinkHints.activateModeWithQueue": LinkHints.activateModeWithQueue.bind(LinkHints),
  "LinkHints.activateModeToOpenIncognito": LinkHints.activateModeToOpenIncognito.bind(LinkHints),
  "LinkHints.activateModeToDownloadLink": LinkHints.activateModeToDownloadLink.bind(LinkHints),
  "LinkHints.activateModeToCopyLinkUrl": LinkHints.activateModeToCopyLinkUrl.bind(LinkHints),

  "Vomnibar.activate": Vomnibar.activate.bind(Vomnibar),
  "Vomnibar.activateInNewTab": Vomnibar.activateInNewTab.bind(Vomnibar),
  "Vomnibar.activateTabSelection": Vomnibar.activateTabSelection.bind(Vomnibar),
  "Vomnibar.activateBookmarks": Vomnibar.activateBookmarks.bind(Vomnibar),
  "Vomnibar.activateBookmarksInNewTab": Vomnibar.activateBookmarksInNewTab.bind(Vomnibar),
  "Vomnibar.activateCommandSelection": Vomnibar.activateCommandSelection.bind(Vomnibar),
  "Vomnibar.activateEditUrl": Vomnibar.activateEditUrl.bind(Vomnibar),
  "Vomnibar.activateEditUrlInNewTab": Vomnibar.activateEditUrlInNewTab.bind(Vomnibar),

  "Marks.activateCreateMode": Marks.activateCreateMode.bind(Marks),
  "Marks.activateGotoMode": Marks.activateGotoMode.bind(Marks),
};

// The types in <input type="..."> that we consider for focusInput command. Right now this is
// recalculated in each content script. Alternatively we could calculate it once in the background
// page and use a request to fetch it each time.
// Should we include the HTML5 date pickers here?

// The corresponding XPath for such elements.
const textInputXPath = (function () {
  const textInputTypes = ["text", "search", "email", "url", "number", "password", "date", "tel"];
  const inputElements = [
    "input[" +
    "(" + textInputTypes.map((type) => '@type="' + type + '"').join(" or ") + "or not(@type))" +
    " and not(@disabled or @readonly)]",
    "textarea",
    "*[@contenteditable='' or translate(@contenteditable, 'TRUE', 'true')='true']",
  ];
  if (typeof DomUtils !== "undefined" && DomUtils !== null) {
    return DomUtils.makeXPath(inputElements);
  }
})();

// used by the findAndFollow* functions.
const followLink = function (linkElement) {
  if (linkElement.nodeName.toLowerCase() === "link") {
    globalThis.location.href = linkElement.href;
  } else {
    // if we can click on it, don't simply set location.href: some next/prev links are meant to
    // trigger AJAX calls, like the 'more' button on GitHub's newsfeed.
    linkElement.scrollIntoView();
    DomUtils.simulateClick(linkElement);
  }
};

// Find links which have text matching any one of `linkStrings`. If there are multiple candidates,
// they are prioritized for shortness, by their position in `linkStrings`, how far down the page
// they are located, and finally by whether the match is exact. Practically speaking, this means we
// favor 'next page' over 'the next big thing', and 'more' over 'nextcompany', even if 'next' occurs
// before 'more' in `linkStrings`.
function findLink(linkStrings) {
  const linksXPath = DomUtils.makeXPath([
    "a",
    "*[@onclick or @role='link' or contains(@class, 'button')]",
  ]);
  const links = DomUtils.evaluateXPath(linksXPath, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
  let candidateLinks = [];

  // At the end of this loop, candidateLinks will contain all visible links that match our patterns
  // links lower in the page are more likely to be the ones we want, so we loop through the snapshot
  // backwards.
  for (let i = links.snapshotLength - 1; i >= 0; i--) {
    const link = links.snapshotItem(i);

    // NOTE(philc): We used to enforce the bounding client rect on the link had nonzero width and
    // height. However, that's not a valid requirement. If an anchor tag has a single floated span
    // as a child, the anchor is still clickable even though it appears to have zero height. This is
    // the case with Google Search's "next" links as of 2025-06. See #4650.

    const computedStyle = globalThis.getComputedStyle(link, null);
    const isHidden = computedStyle.getPropertyValue("visibility") != "visible" ||
      computedStyle.getPropertyValue("display") == "none";
    if (isHidden) {
      continue;
    }

    let linkMatches = false;
    for (const linkString of linkStrings) {
      // SVG elements can have a null innerText.
      const matches = link.innerText?.toLowerCase().includes(linkString) ||
        link.value?.includes?.(linkString) ||
        link.getAttribute("title")?.toLowerCase().includes(linkString) ||
        link.getAttribute("aria-label")?.toLowerCase().includes(linkString);
      if (matches) {
        linkMatches = true;
        break;
      }
    }

    if (!linkMatches) {
      continue;
    }

    candidateLinks.push(link);
  }

  if (candidateLinks.length == 0) {
    return;
  }

  for (const link of candidateLinks) {
    link.wordCount = link.innerText.trim().split(/\s+/).length;
  }

  // We can use this trick to ensure that Array.sort is stable. We need this property to retain the
  // reverse in-page order of the links.

  candidateLinks.forEach((a, i) => a.originalIndex = i);

  // favor shorter links, and ignore those that are more than one word longer than the shortest link
  candidateLinks = candidateLinks
    .sort(function (a, b) {
      if (a.wordCount === b.wordCount) {
        return a.originalIndex - b.originalIndex;
      } else {
        return a.wordCount - b.wordCount;
      }
    })
    .filter((a) => a.wordCount <= (candidateLinks[0].wordCount + 1));

  for (const linkString of linkStrings) {
    const exactWordRegex = /\b/.test(linkString[0]) || /\b/.test(linkString[linkString.length - 1])
      ? new RegExp("\\b" + linkString + "\\b", "i")
      : new RegExp(linkString, "i");
    for (const candidateLink of candidateLinks) {
      if (
        candidateLink.innerText.match(exactWordRegex) ||
        candidateLink.value?.match(exactWordRegex) ||
        candidateLink.getAttribute("title")?.match(exactWordRegex) ||
        candidateLink.getAttribute("aria-label")?.match(exactWordRegex)
      ) {
        return candidateLink;
      }
    }
  }
}

function findElementWithRelValue(value) {
  const relTags = ["link", "a", "area"];
  for (const tag of relTags) {
    const els = document.getElementsByTagName(tag);
    for (const el of Array.from(els)) {
      if (el.hasAttribute("rel") && (el.rel.toLowerCase() === value)) {
        return el;
      }
    }
  }
}

class FocusSelector extends Mode {
  constructor(hints, visibleInputs, selectedInputIndex) {
    super(...arguments);
    super.init({
      name: "focus-selector",
      exitOnClick: true,
      keydown: (event) => {
        if (event.key === "Tab") {
          hints[selectedInputIndex].classList.remove("internal-vimium-selected-input-hint");
          selectedInputIndex += hints.length + (event.shiftKey ? -1 : 1);
          selectedInputIndex %= hints.length;
          hints[selectedInputIndex].classList.add("internal-vimium-selected-input-hint");
          DomUtils.simulateSelect(visibleInputs[selectedInputIndex].element);
          return this.suppressEvent;
        } else if (event.key !== "Shift") {
          this.exit();
          // Give the new mode the opportunity to handle the event.
          return this.restartBubbling;
        }
      },
    });

    const div = DomUtils.createElement("div");
    div.id = "vimiumInputMarkerContainer";
    div.className = "vimium-reset";
    for (const el of hints) {
      div.appendChild(el);
    }
    this.hintContainerEl = div;
    PhantomShadowUI.getContainer().appendChild(div);

    DomUtils.simulateSelect(visibleInputs[selectedInputIndex].element);
    if (visibleInputs.length === 1) {
      this.exit();
      return;
    } else {
      hints[selectedInputIndex].classList.add("internal-vimium-selected-input-hint");
    }
  }

  exit() {
    super.exit();
    DomUtils.removeElement(this.hintContainerEl);
    if (document.activeElement && DomUtils.isEditable(document.activeElement)) {
      return new InsertMode({
        singleton: "post-find-mode/focus-input",
        targetElement: document.activeElement,
        indicator: false,
      });
    }
  }
}



  const HelpDialog = {
    isShowing() {
      return !!(PhantomShadowUI.helpBackdropEl && PhantomShadowUI.helpBackdropEl.classList.contains("visible"));
    },
    abort() {
      if (PhantomShadowUI.helpBackdropEl) {
        PhantomShadowUI.helpBackdropEl.classList.remove("visible");
      }
    },
    toggle() {
      if (!isVimiumActive) return;
      if (!PhantomShadowUI.ensureMounted()) return;
      if (this.isShowing()) {
        this.abort();
      } else {
        PhantomShadowUI.helpBackdropEl.classList.add("visible");
      }
    }
  };

  let windowHasFocus = document.hasFocus();
  function windowIsFocused() {
    return windowHasFocus || (typeof document.hasFocus === "function" && document.hasFocus());
  }

  function isWindowFocusable() {
    return !DomUtils.windowIsTooSmall() && (document.body?.tagName?.toLowerCase() !== "frameset");
  }

  function focusThisFrame(request) {
    if (!request?.forceFocusThisFrame && !isWindowFocusable()) {
      return;
    }
    Utils.nextTick(function () {
      window.focus();
      if (document.activeElement && document.activeElement.tagName && document.activeElement.tagName.toLowerCase() === "iframe") {
        document.activeElement.blur();
      }
    });
  }

  const lastFocusedInput = (function () {
    return () => lastFocusedInputEl;
  })();

  const registeredListeners = [];

  function addTrackedListener(target, type, fn, useCapture) {
    target.addEventListener(type, fn, useCapture);
    registeredListeners.push({ target, type, fn, useCapture });
  }

  function removeAllTrackedListeners() {
    while (registeredListeners.length > 0) {
      const entry = registeredListeners.pop();
      try {
        entry.target.removeEventListener(entry.type, entry.fn, entry.useCapture);
      } catch (_err) {}
    }
  }

  function isEventTargetingFindInput(event) {
    if (!PhantomShadowUI.findInputEl || !event) {
      return false;
    }
    if (
      PhantomShadowUI.shadowRoot &&
      PhantomShadowUI.shadowRoot.activeElement === PhantomShadowUI.findInputEl
    ) {
      return true;
    }
    if (
      PhantomShadowUI.hostEl &&
      event.target === PhantomShadowUI.hostEl &&
      typeof HUD !== "undefined" &&
      HUD.findMode != null
    ) {
      return true;
    }
    if (typeof event.composedPath === "function") {
      return event.composedPath().includes(PhantomShadowUI.findInputEl);
    }
    return false;
  }

  function installListeners() {
    if (registeredListeners.length > 0) {
      return;
    }

    const events = ["keydown", "keypress", "keyup", "click", "focus", "blur", "mousedown", "scroll"];
    for (const type of events) {
      const handler = forTrusted(function (event) {
        if (!isVimiumActive) {
          return true;
        }
        if ((type === "keydown" || type === "keypress" || type === "keyup") && isEventTargetingFindInput(event)) {
          return true;
        }
        if (type === "focus") {
          if (event.target === window) {
            windowHasFocus = true;
          } else if (DomUtils.isEditable(event.target)) {
            lastFocusedInputEl = event.target;
          }
        } else if (type === "blur" && event.target === window) {
          windowHasFocus = false;
        }
        return handlerStack.bubbleEvent(type, event);
      });
      addTrackedListener(window, type, handler, true);
    }

    addTrackedListener(
      document,
      "DOMActivate",
      forTrusted(function (event) {
        if (!isVimiumActive) return true;
        return handlerStack.bubbleEvent("DOMActivate", event);
      }),
      true
    );
  }

  let initPromise = null;
  let baseRuntimeListenerCount = -1;
  let baseStorageListenerCount = -1;

  async function ensureInitialized() {
    if (initialized) {
      return;
    }
    if (initPromise) {
      return initPromise;
    }

    if (
      baseRuntimeListenerCount < 0 &&
      typeof runtimeMessageListeners !== "undefined" &&
      Array.isArray(runtimeMessageListeners)
    ) {
      baseRuntimeListenerCount = runtimeMessageListeners.length;
    }
    if (
      baseStorageListenerCount < 0 &&
      typeof storageChangeListeners !== "undefined" &&
      Array.isArray(storageChangeListeners)
    ) {
      baseStorageListenerCount = storageChangeListeners.length;
    }

    initPromise = (async function () {
      try {
        if (typeof Utils !== "undefined" && typeof Utils.populateBrowserInfo === "function") {
          await Utils.populateBrowserInfo();
        }
        await Settings.onLoaded();
        await Commands.init();
        await FindModeHistory.init();
        if (!isVimiumActive) {
          initialized = false;
          return;
        }
        normalMode = new NormalMode();
        normalMode.init();
        Scroller.init();
        new InsertMode({ permanent: true });
        initialized = true;
        if (isVimiumActive && Settings.get("grabBackFocus")) {
          // Only grab back auto-focused inputs on initial load if Vimium was enabled at startup.
          if (document.activeElement && DomUtils.isFocusable(document.activeElement)) {
            try { document.activeElement.blur(); } catch (_err) {}
          }
        }
      } catch (err) {
        initialized = false;
        initPromise = null;
        normalMode = null;
        try { console.error("[Phantom Vimium] Initialization failed:", err); } catch (_e) {}
        throw err;
      }
    })();

    return initPromise;
  }

  async function enable() {
    isVimiumActive = true;
    installListeners();
    try {
      await ensureInitialized();
      if (!isVimiumActive) {
        return;
      }
      if (normalMode == null) {
        normalMode = new NormalMode();
        normalMode.init();
        Scroller.init();
        new InsertMode({ permanent: true });
      }
    } catch (_err) {
      // Logged in ensureInitialized
    }
  }

  function disable() {
    isVimiumActive = false;
    try { HintCoordinator.exit({ isSuccess: false }); } catch (_err) {}
    try { HelpDialog.abort(); } catch (_err) {}
    try { HUD.hide(true, false); } catch (_err) {}
    try { Mode.reset(); } catch (_err) {}
    try { handlerStack.reset(); } catch (_err) {}
    if (
      baseRuntimeListenerCount >= 0 &&
      typeof runtimeMessageListeners !== "undefined" &&
      Array.isArray(runtimeMessageListeners) &&
      runtimeMessageListeners.length > baseRuntimeListenerCount
    ) {
      runtimeMessageListeners.length = baseRuntimeListenerCount;
    }
    if (
      baseStorageListenerCount >= 0 &&
      typeof storageChangeListeners !== "undefined" &&
      Array.isArray(storageChangeListeners) &&
      storageChangeListeners.length > baseStorageListenerCount
    ) {
      storageChangeListeners.length = baseStorageListenerCount;
    }
    normalMode = null;
    initialized = false;
    initPromise = null;
    removeAllTrackedListeners();
    PhantomShadowUI.cleanup();
    HUD._findWired = false;
  }

  function isEnabled() {
    return isVimiumActive;
  }

  function sync(shouldEnable, policy) {
    if (typeof policy === "string" && policy.length > 0) {
      clipboardPolicy = policy;
    }
    if (shouldEnable) {
      if (!isVimiumActive) {
        enable();
      }
    } else {
      if (isVimiumActive) {
        disable();
      }
    }
  }

  window.__phantomVimium = {
    enable: enable,
    disable: disable,
    isEnabled: isEnabled,
    sync: sync
  };
})();
