/*
 * Phantom Dark Reader Bootstrapper
 * Idempotent controller guarded by window.__phantomDarkReader.
 */
(function () {
  "use strict";

  if (window.__phantomDarkReader) {
    return;
  }

  const DEFAULT_THEME = {
    mode: 1,
    brightness: 100,
    contrast: 95,
    sepia: 5
  };

  const EXAM_FIXES = {
    invert: [],
    ignoreImageAnalysis: [
      "img.tex",
      "img.latex",
      "img.math",
      "img.Wirisformula",
      "img[src*='latex']",
      "img[src*='codecogs']",
      "img[src*='mimetex']",
      "svg",
      "canvas"
    ],
    ignoreInlineStyle: [
      ".MathJax *",
      "mjx-container *",
      ".katex *"
    ],
    css: [
      ".MathJax, .MathJax_Display, mjx-container, mjx-math, .katex, .katex-display, .katex-html { color: inherit !important; }",
      "mjx-container svg, .MathJax_SVG svg { fill: currentColor; }",
      "canvas { background-color: transparent; }",
      "img.Wirisformula, img.tex, img.latex, img.math, img[src*='codecogs.com'], img[src*='mimetex'] { background-color: rgba(255, 255, 255, 0.9) !important; border-radius: 3px; padding: 1px 3px; }",
      "#phantom-vimium-host, #phantom-toast-host { color-scheme: initial !important; }"
    ].join("\n")
  };

  const OFFICIAL_SITE_FIXES = [
    {
      match: function (host) {
        return host === "docs.google.com";
      },
      fix: {
        invert: [
          ".docs-icon-img:not(.docs-icon-editors-ia-add-comment)",
          ".kix-cursor-caret"
        ],
        ignoreImageAnalysis: [
          ".docs-icon-img"
        ],
        ignoreInlineStyle: [
          ".kix-lineview *",
          ".kix-wordhtmlgenerator-word-node"
        ],
        css: [
          ".freebirdFormviewerViewFormContentWrapper, .freebirdFormviewerViewNumberedItemContainer { border-color: rgba(255, 255, 255, 0.14) !important; }",
          ".freebirdFormviewerComponentsQuestionRadioRadio, .quantumWizTogglePaperradioOuterCircle, .quantumWizTogglePapercheckboxInnerBox { border-color: currentColor !important; }",
          ".docs-material .jfk-textinput, .docs-gm-dialogs { background-color: #202124 !important; color: #e8eaed !important; }"
        ].join("\n")
      }
    },
    {
      match: function (host) {
        return host === "accounts.google.com";
      },
      fix: {
        ignoreInlineStyle: ["svg"],
        css: [
          ".rFrNMe .AxOyFc { background-color: transparent !important; }",
          "input, select, textarea { color: inherit !important; }"
        ].join("\n")
      }
    },
    {
      match: function (host) {
        return host === "instructure.com" || host.endsWith(".instructure.com");
      },
      fix: {
        invert: [
          ".ic-app-header__logomark",
          "#header-logo",
          ".mce-ico"
        ],
        ignoreImageAnalysis: [
          ".ic-app-header__logomark",
          "#header-logo",
          ".mce-ico"
        ],
        css: [
          "body.ic-Layout-Body { background-image: none !important; }",
          ".tox-tinymce, .mce-panel { border-color: rgba(255, 255, 255, 0.16) !important; }"
        ].join("\n")
      }
    }
  ];

  function getSiteFixes(hostname) {
    const host = String(hostname || "").toLowerCase();
    const merged = {
      invert: EXAM_FIXES.invert.slice(),
      ignoreImageAnalysis: EXAM_FIXES.ignoreImageAnalysis.slice(),
      ignoreInlineStyle: EXAM_FIXES.ignoreInlineStyle.slice(),
      css: EXAM_FIXES.css
    };

    for (let i = 0; i < OFFICIAL_SITE_FIXES.length; i += 1) {
      const entry = OFFICIAL_SITE_FIXES[i];
      if (!entry.match(host)) {
        continue;
      }
      const fix = entry.fix;
      if (fix.invert) {
        merged.invert = merged.invert.concat(fix.invert);
      }
      if (fix.ignoreImageAnalysis) {
        merged.ignoreImageAnalysis = merged.ignoreImageAnalysis.concat(fix.ignoreImageAnalysis);
      }
      if (fix.ignoreInlineStyle) {
        merged.ignoreInlineStyle = merged.ignoreInlineStyle.concat(fix.ignoreInlineStyle);
      }
      if (fix.css) {
        merged.css = merged.css + "\n" + fix.css;
      }
    }

    return merged;
  }

  const PREFLASH_ID = "phantom-dr-preflash";
  const EARLY_PREFLASH_ID = "phantom-dr-early-preflash";
  const EXAM_STYLE_ID = "phantom-dr-exam-fixes";

  let enabled = false;
  let currentTheme = Object.assign({}, DEFAULT_THEME);
  let preflashObserver = null;
  let domReadyListener = null;
  let pendingSeq = 0;
  const pendingFetches = new Map();

  function installTrustedTypesShim() {
    try {
      if (window.trustedTypes && typeof window.trustedTypes.createPolicy === "function" && !window.trustedTypes.defaultPolicy) {
        window.trustedTypes.createPolicy("default", {
          createHTML: function (s) { return s; },
          createScript: function (s) { return s; },
          createScriptURL: function (s) { return s; }
        });
      }
    } catch (_err) {
      // Host CSP may restrict policy names; ignore safely.
    }
  }

  function removeElementById(id) {
    try {
      const el = document.getElementById(id);
      if (el && el.parentNode) {
        el.parentNode.removeChild(el);
      }
    } catch (_err) {}
  }

  function injectPreFlash() {
    try {
      const insert = function () {
        const parent = document.head || document.documentElement;
        if (!parent) {
          return false;
        }
        if (!document.getElementById(PREFLASH_ID)) {
          const style = document.createElement("style");
          style.id = PREFLASH_ID;
          style.textContent = "html, body { background-color: #181a1b !important; color: #e8e6e3 !important; color-scheme: dark !important; }";
          parent.appendChild(style);
        }
        return true;
      };

      if (!insert() && !preflashObserver && typeof MutationObserver !== "undefined") {
        preflashObserver = new MutationObserver(function () {
          if (insert() && preflashObserver) {
            preflashObserver.disconnect();
            preflashObserver = null;
          }
        });
        preflashObserver.observe(document, { childList: true, subtree: true });
      }
    } catch (_err) {}
  }

  function removePreFlash() {
    try {
      if (preflashObserver) {
        preflashObserver.disconnect();
        preflashObserver = null;
      }
    } catch (_err) {}
    removeElementById(PREFLASH_ID);
    removeElementById(EARLY_PREFLASH_ID);
  }

  function ensureExamStyle() {
    try {
      const parent = document.head || document.documentElement;
      if (!parent) {
        return;
      }
      if (!document.getElementById(EXAM_STYLE_ID)) {
        const style = document.createElement("style");
        style.id = EXAM_STYLE_ID;
        style.textContent = EXAM_FIXES.css;
        parent.appendChild(style);
      }
    } catch (_err) {}
  }

  function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function fetchViaBridge(resolvedUrl) {
    return new Promise(function (resolve, reject) {
      if (!window.CefSharp || typeof window.CefSharp.PostMessage !== "function") {
        reject(new Error("CefSharp bridge unavailable"));
        return;
      }
      const requestId =
        "dr_" +
        (++pendingSeq) +
        "_" +
        Date.now() +
        "_" +
        Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(function () {
        pendingFetches.delete(requestId);
        reject(new Error("Phantom CSS fetch timed out: " + resolvedUrl));
      }, 15000);

      pendingFetches.set(requestId, { resolve: resolve, reject: reject, timer: timer });

      try {
        let isMainFrame = true;
        try {
          isMainFrame = window.top === window;
        } catch (_frameErr) {
          isMainFrame = false;
        }

        window.CefSharp.PostMessage({
          Type: "Phantom",
          Service: "fetchCss",
          RequestId: requestId,
          Url: resolvedUrl,
          FrameUrl: String(window.location && window.location.href ? window.location.href : ""),
          IsMainFrame: isMainFrame
        });
      } catch (err) {
        clearTimeout(timer);
        pendingFetches.delete(requestId);
        reject(err);
      }
    });
  }

  function __onCssFetched(requestId, payload) {
    const entry = pendingFetches.get(requestId);
    if (!entry) {
      return;
    }
    pendingFetches.delete(requestId);
    clearTimeout(entry.timer);

    if (!payload || !payload.ok) {
      entry.reject(new Error((payload && payload.error) || "Bridge CSS fetch failed"));
      return;
    }

    try {
      const body =
        typeof payload.text === "string"
          ? payload.text
          : payload.base64
          ? base64ToUint8Array(payload.base64)
          : new Uint8Array(0);
      const response = new Response(body, {
        status: payload.status || 200,
        statusText: "OK",
        headers: {
          "Content-Type": payload.contentType || "text/css; charset=utf-8"
        }
      });
      entry.resolve(response);
    } catch (err) {
      entry.reject(err);
    }
  }

  async function phantomFetch(url) {
    let resolvedUrl = url;
    try {
      resolvedUrl = new URL(url, window.location.href).href;
    } catch (_err) {}

    if (/^(data|blob):/i.test(resolvedUrl)) {
      return window.fetch(resolvedUrl);
    }

    let isSameOrigin = false;
    try {
      isSameOrigin = new URL(resolvedUrl).origin === window.location.origin;
    } catch (_err) {}

    if (isSameOrigin) {
      try {
        const res = await window.fetch(resolvedUrl, { credentials: "include", mode: "cors" });
        if (res && res.ok) {
          return res;
        }
      } catch (_err) {
        // Fall through to C# proxy if blocked or redirected cross-origin.
      }
    }

    if (/^https?:/i.test(resolvedUrl)) {
      return fetchViaBridge(resolvedUrl);
    }

    return window.fetch(resolvedUrl);
  }

  function configureFetchMethod() {
    if (!window.DarkReader) {
      return;
    }
    if (typeof window.DarkReader.setFetchMethod === "function") {
      window.DarkReader.setFetchMethod(phantomFetch);
    }
    window.DarkReader.Plugins = Object.assign({}, window.DarkReader.Plugins || {}, {
      fetch: async function (request) {
        const targetUrl = request && request.url ? request.url : request;
        const response = await phantomFetch(targetUrl);
        if (request && request.responseType === "data-url") {
          const blob = await response.blob();
          return await new Promise(function (resolve, reject) {
            const reader = new FileReader();
            reader.onloadend = function () {
              resolve(reader.result);
            };
            reader.onerror = function (err) {
              reject(err);
            };
            reader.readAsDataURL(blob);
          });
        }
        return await response.text();
      }
    });
  }

  function isSameTheme(a, b) {
    if (!a || !b) {
      return false;
    }
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) {
      return false;
    }
    for (let i = 0; i < keysA.length; i += 1) {
      const key = keysA[i];
      if (a[key] !== b[key]) {
        return false;
      }
    }
    return true;
  }

  function schedulePreflashRemoval() {
    const runCleanup = function () {
      if (document.readyState === "loading") {
        return;
      }
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(removePreFlash);
      } else {
        setTimeout(removePreFlash, 0);
      }
    };

    if (document.readyState === "loading") {
      const onReady = function () {
        document.removeEventListener("DOMContentLoaded", onReady);
        runCleanup();
      };
      document.addEventListener("DOMContentLoaded", onReady);
    } else {
      runCleanup();
    }
  }

  function applyNow() {
    if (!enabled) {
      return;
    }
    if (!document.head && !document.documentElement) {
      return;
    }

    installTrustedTypesShim();
    configureFetchMethod();

    try {
      if (window.DarkReader && typeof window.DarkReader.enable === "function") {
        const hostname = window.location ? window.location.hostname : "";
        window.DarkReader.enable(currentTheme, getSiteFixes(hostname));
      }
      ensureExamStyle();
    } catch (_err) {
      // Never leak unhandled exceptions into exam pages with strict CSP.
    }

    schedulePreflashRemoval();
  }

  function enable(themeOptions) {
    const nextTheme = Object.assign({}, DEFAULT_THEME, themeOptions || {});
    if (
      enabled &&
      window.DarkReader &&
      typeof window.DarkReader.isEnabled === "function" &&
      window.DarkReader.isEnabled() &&
      isSameTheme(currentTheme, nextTheme)
    ) {
      ensureExamStyle();
      schedulePreflashRemoval();
      return;
    }

    currentTheme = nextTheme;
    enabled = true;

    if (document.documentElement) {
      applyNow();
    } else {
      injectPreFlash();
      if (!domReadyListener) {
        domReadyListener = function () {
          document.removeEventListener("DOMContentLoaded", domReadyListener);
          domReadyListener = null;
          if (enabled) {
            applyNow();
          }
        };
        document.addEventListener("DOMContentLoaded", domReadyListener);
      }
    }
  }

  function disable() {
    enabled = false;

    if (domReadyListener) {
      document.removeEventListener("DOMContentLoaded", domReadyListener);
      domReadyListener = null;
    }

    removePreFlash();
    removeElementById(EXAM_STYLE_ID);

    try {
      if (window.DarkReader && typeof window.DarkReader.disable === "function") {
        window.DarkReader.disable();
      }
    } catch (_err) {}

    // Defensive cleanup of any Dark Reader style tags or attributes.
    try {
      const residualStyles = document.querySelectorAll("style.darkreader");
      for (let i = 0; i < residualStyles.length; i++) {
        const node = residualStyles[i];
        if (node.parentNode) {
          node.parentNode.removeChild(node);
        }
      }
      const root = document.documentElement;
      if (root) {
        root.removeAttribute("data-darkreader-mode");
        root.removeAttribute("data-darkreader-scheme");
      }
    } catch (_err) {}
  }

  function isEnabled() {
    try {
      if (window.DarkReader && typeof window.DarkReader.isEnabled === "function") {
        return enabled || window.DarkReader.isEnabled();
      }
    } catch (_err) {}
    return enabled;
  }

  function sync(shouldEnable, themeOptions) {
    if (shouldEnable) {
      enable(themeOptions);
    } else {
      disable();
    }
  }

  installTrustedTypesShim();
  configureFetchMethod();

  window.__phantomDarkReader = {
    enable: enable,
    disable: disable,
    isEnabled: isEnabled,
    sync: sync,
    injectPreFlash: injectPreFlash,
    removePreFlash: removePreFlash,
    __onCssFetched: __onCssFetched
  };
})();
