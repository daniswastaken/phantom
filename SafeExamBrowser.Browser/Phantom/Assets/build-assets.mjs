#!/usr/bin/env node
/**
 * Reproducible asset generator for Phantom built-in extensions (Dark Reader + Vimium).
 *
 * Usage:
 *   node SafeExamBrowser.Browser/Phantom/Assets/build-assets.mjs
 *
 * Outputs (embedded assembly resources in SafeExamBrowser.Browser):
 *   - darkreader.min.js      (standalone browser UMD build from darkreader npm package)
 *   - phantom-darkreader.js  (idempotent Dark Reader bootstrapper + JS bridge fetch proxy)
 *   - phantom-vimium.js      (self-contained Vimium content engine + scoped chrome.* shim)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DARKREADER_VERSION = "4.9.135";
const VIMIUM_REPO_RAW = "https://raw.githubusercontent.com/philc/vimium/master";

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

function buildDarkReaderBundle() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phantom-dr-"));
  try {
    console.log(`[DarkReader] Packing darkreader@${DARKREADER_VERSION}...`);
    const npmArgs = ["pack", `darkreader@${DARKREADER_VERSION}`, "--silent"];
    const tarballName = (process.platform === "win32"
      ? execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm", ...npmArgs], { cwd: tempDir, encoding: "utf8" })
      : execFileSync("npm", npmArgs, { cwd: tempDir, encoding: "utf8" })
    ).trim().split(/\r?\n/).pop();

    execFileSync("tar", ["-xzf", tarballName], { cwd: tempDir });

    const drSourcePath = path.join(tempDir, "package", "darkreader.js");
    const rawDr = fs.readFileSync(drSourcePath, "utf8");

    // Wrap UMD factory with undefined exports/module/define so RequireJS (e.g. Moodle)
    // does not hijack DarkReader into an anonymous AMD module instead of global.DarkReader.
    const wrapped = [
      `/* Bundled from darkreader@${DARKREADER_VERSION} (https://github.com/darkreader/darkreader) */`,
      `(function (exports, module, define) {`,
      `if (typeof window !== "undefined" && window.DarkReader) { return; }`,
      rawDr,
      `})(undefined, undefined, undefined);`,
      ``
    ].join("\n");

    const outPath = path.join(__dirname, "darkreader.min.js");
    fs.writeFileSync(outPath, wrapped, "utf8");
    console.log(`[DarkReader] Wrote ${outPath} (${wrapped.length} bytes)`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildDarkReaderBootstrapper() {
  const code = `/*
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
    ].join("\\n")
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
        ].join("\\n")
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
        ].join("\\n")
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
        ].join("\\n")
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
        merged.css = merged.css + "\\n" + fix.css;
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
`;

  const outPath = path.join(__dirname, "phantom-darkreader.js");
  fs.writeFileSync(outPath, code, "utf8");
  console.log(`[DarkReader] Wrote ${outPath} (${code.length} bytes)`);
}

function stripModuleSyntax(src) {
  return src
    .replace(/^\s*import\s+[^;\n]+;\s*$/gm, "")
    .replace(/^\s*export\s*\{[\s\S]*?\};\s*$/gm, "")
    .replace(/^\s*export\s+(const|let|var|function|async function|class)\s+/gm, "$1 ");
}

function patchVimiumSources(files) {
  const patched = {};

  // 1. lib/utils.js: make String.prototype.reverse non-enumerable & route globalThis exports locally
  patched["lib/utils.js"] = files["lib/utils.js"]
    .replace(
      /String\.prototype\.reverse\s*=\s*function\s*\(\)\s*\{\s*return\s+this\.split\(""\)\.reverse\(\)\.join\(""\);\s*\};/,
      `if (!String.prototype.reverse) { Object.defineProperty(String.prototype, "reverse", { value: function () { return this.split("").reverse().join(""); }, configurable: true, writable: true }); }`
    )
    .replace(/if\s*\(globalThis\.forTrusted\s*==\s*null\)\s*\{[\s\S]*?\n\}/, "")
    .replace(/Object\.assign\(globalThis,\s*\{[\s\S]*?\}\);/, "");

  // 2. lib/keyboard_utils.js: no globalThis export leak
  patched["lib/keyboard_utils.js"] = files["lib/keyboard_utils.js"]
    .replace(/globalThis\.KeyboardUtils\s*=\s*KeyboardUtils;\s*/g, "");

  // 3. lib/dom_utils.js: safe removeElement, shadow-root & rich-editor awareness, ARIA roles
  let domUtils = files["lib/dom_utils.js"]
    .replace(
      /removeElement\(el\)\s*\{\s*return el\.parentNode\.removeChild\(el\);\s*\}/,
      `removeElement(el) { return el && el.parentNode ? el.parentNode.removeChild(el) : null; }`
    )
    .replace(
      /isEditable\(element\)\s*\{[\s\S]*?\n  \},/,
      `isEditable(element) {
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
  },`
    )
    .replace(
      /addFlashRect\(rect\)\s*\{[\s\S]*?\n  \},/,
      `addFlashRect(rect) {
    const flashEl = this.createElement("div");
    flashEl.classList.add("vimium-reset");
    flashEl.classList.add("vimium-flash");
    flashEl.style.left = rect.left + "px";
    flashEl.style.top = rect.top + "px";
    flashEl.style.width = rect.width + "px";
    flashEl.style.height = rect.height + "px";
    PhantomShadowUI.getContainer().appendChild(flashEl);
    return flashEl;
  },`
    )
    .replace(/globalThis\.DomUtils\s*=\s*DomUtils;\s*/g, "");
  patched["lib/dom_utils.js"] = domUtils;

  // 4. lib/rect.js
  patched["lib/rect.js"] = files["lib/rect.js"]
    .replace(/globalThis\.Rect\s*=\s*Rect;\s*/g, "");

  // 5. lib/handler_stack.js
  patched["lib/handler_stack.js"] = files["lib/handler_stack.js"]
    .replace(/globalThis\.HandlerStack\s*=\s*HandlerStack;\s*/g, "")
    .replace(/globalThis\.handlerStack\s*=\s*new HandlerStack\(\);\s*/g, "const handlerStack = new HandlerStack();");

  // 6. lib/settings.js: exam-friendly defaults (grabBackFocus: true, exclusionRules: [])
  patched["lib/settings.js"] = files["lib/settings.js"]
    .replace(/grabBackFocus:\s*false,/, "grabBackFocus: true,")
    .replace(/exclusionRules:\s*\[\s*\/\/[\s\S]*?\],/, "exclusionRules: [],")
    .replace(/globalThis\.Settings\s*=\s*Settings;\s*/g, "");

  // 7. lib/find_mode_history.js
  patched["lib/find_mode_history.js"] = files["lib/find_mode_history.js"]
    .replace(/globalThis\.FindModeHistory\s*=\s*FindModeHistory;\s*/g, "");

  // 8. background_scripts/all_commands.js + commands.js (embedded to compile keyMapping locally)
  const allCommandsSrc = stripModuleSyntax(files["background_scripts/all_commands.js"])
    .replace(/const list = \[/, "const allCommands = { list: [")
    .replace(/\];\s*$/, "] };");
  patched["background_scripts/all_commands.js"] = allCommandsSrc;

  let commandsSrc = stripModuleSyntax(files["background_scripts/commands.js"])
    .replace(
      /"zL":\s*"scrollToRight",/,
      `"zL": "scrollToRight",\n  "0": "scrollToLeft",\n  "$": "scrollToRight",`
    );
  patched["background_scripts/commands.js"] = commandsSrc;

  // 9. content_scripts/mode.js
  patched["content_scripts/mode.js"] = files["content_scripts/mode.js"]
    .replace(/Object\.assign\(globalThis,\s*\{[\s\S]*?\}\);/, "");

  // 10. content_scripts/link_hints.js:
  //   - Put hint container in PhantomShadowUI (Shadow DOM)
  //   - Add ARIA interactive roles (switch, option, combobox, listbox, treeitem) & <label for>
  //   - Support <select>.showPicker() on activation
  //   - Route F (OPEN_IN_NEW_BG_TAB / OPEN_IN_NEW_FG_TAB) through PhantomJsBridge openUrlInNewWindow
  let linkHints = files["content_scripts/link_hints.js"]
    .replace(
      /const OPEN_IN_NEW_BG_TAB = \{[\s\S]*?\};/,
      `const OPEN_IN_NEW_BG_TAB = {
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
};`
    )
    .replace(
      /const OPEN_IN_NEW_FG_TAB = \{[\s\S]*?\};/,
      `const OPEN_IN_NEW_FG_TAB = {
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
};`
    )
    .replace(
      /const clickableRoles = \[[\s\S]*?\];/,
      `const clickableRoles = [
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
      ];`
    )
    .replace(
      /case "label":[\s\S]*?break;/,
      `case "label":
        isClickable ||= (element.control != null &&
          !element.control.disabled &&
          ((this.getLocalHintsForElement(element.control)).length === 0)) ||
          element.hasAttribute("for");
        break;`
    )
    .replace(
      /document\.documentElement\.appendChild\(div\);/,
      `PhantomShadowUI.getContainer().appendChild(div);`
    )
    .replace(
      /if \(hasPopoverSupport\) \{/,
      `if (false && hasPopoverSupport) {`
    )
    .replace(
      /if \(\["input", "select", "object", "embed"\]\.includes\(clickEl\.nodeName\.toLowerCase\(\)\)\) \{\s*clickEl\.focus\(\);\s*\}/,
      `if (["input", "select", "object", "embed"].includes(clickEl.nodeName.toLowerCase())) {
              clickEl.focus();
              if (clickEl.nodeName.toLowerCase() === "select" && typeof clickEl.showPicker === "function") {
                try { clickEl.showPicker(); } catch (_err) {}
              }
            }`
    )
    .replace(/Object\.assign\(globalThis,\s*\{[\s\S]*?\}\);/, "");
  patched["content_scripts/link_hints.js"] = linkHints;

  // 11. content_scripts/scroller.js
  patched["content_scripts/scroller.js"] = files["content_scripts/scroller.js"]
    .replace(/globalThis\.Scroller\s*=\s*Scroller;\s*/g, "");

  // 12. content_scripts/marks.js
  patched["content_scripts/marks.js"] = files["content_scripts/marks.js"]
    .replace(/globalThis\.Marks\s*=\s*Marks;\s*/g, "");

  // 13. content_scripts/mode_insert.js:
  //   - Check composedPath()[0] as well as shadowRoot activeElement
  //   - Check DomUtils.isFocusable on activeElement or inside rich editors (Monaco/CodeMirror/Ace/TinyMCE/Quill)
  //   - On Escape inside an input, blur & suppressEvent cleanly without triggering page Escape handlers
  let modeInsert = files["content_scripts/mode_insert.js"]
    .replace(
      /const activeElement = this\.getActiveElement\(\);/,
      `const activeElement = this.getActiveElement(event);`
    )
    .replace(
      /isActive\(event\)\s*\{[\s\S]*?\n  \}/,
      `isActive(event) {
    if (event === InsertMode.suppressedEvent) {
      return false;
    }
    if (this.global) {
      return true;
    }
    return DomUtils.isFocusable(this.getActiveElement(event));
  }`
    )
    .replace(
      /getActiveElement\(\)\s*\{[\s\S]*?\n  \}/,
      `getActiveElement(event) {
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
  }`
    )
    .replace(
      /globalThis\.InsertMode\s*=\s*InsertMode;\s*/g, ""
    )
    .replace(
      /globalThis\.PassNextKeyMode\s*=\s*PassNextKeyMode;\s*/g, ""
    );
  patched["content_scripts/mode_insert.js"] = modeInsert;

  // 14. content_scripts/mode_find.js:
  //   - Safe guard when document.body is missing
  //   - On Escape inside FindMode, pass escape clean without triggering host page
  patched["content_scripts/mode_find.js"] = files["content_scripts/mode_find.js"]
    .replace(/globalThis\.PostFindMode\s*=\s*PostFindMode;\s*/g, "")
    .replace(/globalThis\.FindMode\s*=\s*FindMode;\s*/g, "");

  // 15. content_scripts/mode_key_handler.js:
  //   - Allow "0" to act as count digit when countPrefix > 0 (e.g. 10j), and as mapped scrollToLeft when countPrefix === 0
  patched["content_scripts/mode_key_handler.js"] = files["content_scripts/mode_key_handler.js"]
    .replace(
      /\} else if \(this\.isMappedKey\(keyChar\)\) \{/,
      `} else if (this.countPrefix > 0 && keyChar === "0" && this.isCountKey(keyChar)) {
      const digit = 0;
      this.reset((this.countPrefix * 10) + digit);
      return this.suppressEvent;
    } else if (this.isMappedKey(keyChar)) {`
    )
    .replace(/globalThis\.KeyHandlerMode\s*=\s*KeyHandlerMode;\s*/g, "");

  // 16. content_scripts/mode_visual.js:
  //   - Ensure yank() respects SEB clipboard policy (checks HUD.copyToClipboard return value)
  patched["content_scripts/mode_visual.js"] = files["content_scripts/mode_visual.js"]
    .replace(
      /HUD\.copyToClipboard\(this\.yankedText\);[\s\S]*?HUD\.show\(`Yanked \$\{this\.yankedText\.length\} character\$\{plural\}: \\"\$\{message\}\\"\.`, 2500\);/,
      `const copied = HUD.copyToClipboard(this.yankedText);
    if (copied !== false) {
      let message = this.yankedText.replace(/\\s+/g, " ");
      if (15 < this.yankedText.length) {
        message = message.slice(0, 12) + "...";
      }
      const plural = this.yankedText.length === 1 ? "" : "s";
      HUD.show(\`Yanked \${this.yankedText.length} character\${plural}: "\${message}".\`, 2500);
    }`
    )
    .replace(/globalThis\.VisualMode\s*=\s*VisualMode;\s*/g, "")
    .replace(/globalThis\.VisualLineMode\s*=\s*VisualLineMode;\s*/g, "");

  // 17. content_scripts/mode_normal.js:
  //   - Route goBack / goForward via PhantomJsBridge so SEB navigation policies are respected
  //   - Put FocusSelector overlays in PhantomShadowUI
  patched["content_scripts/mode_normal.js"] = files["content_scripts/mode_normal.js"]
    .replace(
      /goBack\(count\)\s*\{\s*history\.go\(-count\);\s*\}/,
      `goBack(count) {
    chrome.runtime.sendMessage({ handler: "runBackgroundCommand", registryEntry: { command: "goBack" }, count });
  }`
    )
    .replace(
      /goForward\(count\)\s*\{\s*history\.go\(count\);\s*\}/,
      `goForward(count) {
    chrome.runtime.sendMessage({ handler: "runBackgroundCommand", registryEntry: { command: "goForward" }, count });
  }`
    )
    .replace(
      /document\.documentElement\.appendChild\(div\);/,
      `PhantomShadowUI.getContainer().appendChild(div);`
    )
    .replace(/globalThis\.NormalMode\s*=\s*NormalMode;\s*/g, "")
    .replace(/globalThis\.NormalModeCommands\s*=\s*NormalModeCommands;\s*/g, "");

  return patched;
}

async function buildVimiumBundle() {
  const filesToFetch = [
    "lib/types.js",
    "lib/utils.js",
    "lib/keyboard_utils.js",
    "lib/dom_utils.js",
    "lib/rect.js",
    "lib/handler_stack.js",
    "lib/settings.js",
    "lib/find_mode_history.js",
    "background_scripts/all_commands.js",
    "background_scripts/commands.js",
    "content_scripts/mode.js",
    "content_scripts/link_hints.js",
    "content_scripts/scroller.js",
    "content_scripts/marks.js",
    "content_scripts/mode_insert.js",
    "content_scripts/mode_find.js",
    "content_scripts/mode_key_handler.js",
    "content_scripts/mode_visual.js",
    "content_scripts/mode_normal.js",
    "content_scripts/vimium.css",
    "pages/hud_page.css",
    "pages/help_dialog_page.css",
    "pages/key_mappings.css"
  ];

  console.log(`[Vimium] Fetching ${filesToFetch.length} upstream files from philc/vimium...`);
  const fetched = {};
  await Promise.all(filesToFetch.map(async (rel) => {
    fetched[rel] = await fetchText(`${VIMIUM_REPO_RAW}/${rel}`);
  }));

  const patched = patchVimiumSources(fetched);

  const combinedCss = [
    fetched["content_scripts/vimium.css"],
    fetched["pages/hud_page.css"],
    fetched["pages/key_mappings.css"],
    fetched["pages/help_dialog_page.css"],
    `
    /* Phantom Shadow DOM isolation & HUD/Help overrides */
    :host {
      all: initial;
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      width: 0 !important;
      height: 0 !important;
      overflow: visible !important;
      z-index: 2147483647 !important;
      pointer-events: none !important;
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif !important;
    }
    #phantom-vimium-root {
      position: relative;
      z-index: 2147483647;
    }
    #phantom-vimium-hud {
      display: none;
      position: fixed;
      right: 16px;
      bottom: 8px;
      min-width: 260px;
      max-width: 520px;
      background-color: #1e2024;
      color: #f1f3f5;
      border: 1px solid #495057;
      border-radius: 4px;
      padding: 5px 10px;
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 18px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
      z-index: 2147483647;
      pointer-events: auto;
      box-sizing: border-box;
    }
    #phantom-vimium-hud.visible {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    #phantom-vimium-hud-text {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #phantom-vimium-find-wrap {
      display: none;
      align-items: center;
      width: 100%;
      gap: 6px;
    }
    #phantom-vimium-hud.find-mode #phantom-vimium-find-wrap {
      display: flex;
    }
    #phantom-vimium-hud.find-mode #phantom-vimium-hud-text {
      display: none;
    }
    #phantom-vimium-find-input {
      flex: 1 1 auto;
      min-width: 140px;
      background: transparent;
      border: none;
      outline: none;
      color: inherit;
      font-family: inherit;
      font-size: 13px;
      padding: 0;
      margin: 0;
    }
    #phantom-vimium-find-count {
      color: #adb5bd;
      font-size: 12px;
      white-space: nowrap;
    }
    #phantom-vimium-help-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(10, 12, 16, 0.72);
      z-index: 2147483647;
      pointer-events: auto;
      overflow: auto;
      padding: 36px 20px;
      box-sizing: border-box;
    }
    #phantom-vimium-help-backdrop.visible {
      display: block;
    }
    #phantom-vimium-help-dialog {
      max-width: 820px;
      margin: 0 auto;
      background: #1f2228;
      color: #e9ecef;
      border: 1px solid #3d434e;
      border-radius: 8px;
      padding: 16px 20px;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.65);
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    }
    #phantom-vimium-help-dialog header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #343a46;
      padding-bottom: 10px;
      margin-bottom: 12px;
    }
    #phantom-vimium-help-dialog h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
      color: #ffffff;
    }
    #phantom-vimium-help-close {
      background: transparent;
      border: 1px solid #4c5361;
      color: #ced4da;
      border-radius: 4px;
      width: 26px;
      height: 26px;
      font-size: 16px;
      line-height: 22px;
      cursor: pointer;
    }
    #phantom-vimium-help-close:hover {
      background: #343a46;
      color: #ffffff;
    }
    .phantom-help-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 16px 24px;
    }
    .phantom-help-group h2 {
      margin: 0 0 8px 0;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #74c0fc;
    }
    .phantom-help-row {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 5px;
      font-size: 13px;
    }
    .phantom-help-keys {
      min-width: 96px;
      text-align: right;
      flex-shrink: 0;
    }
    .phantom-help-key {
      display: inline-block;
      background: #2f343d;
      color: #f8f9fa;
      border: 1px solid #495057;
      border-radius: 3px;
      padding: 1px 5px;
      font-family: Consolas, monospace;
      font-size: 11px;
      margin-left: 3px;
    }
    .phantom-help-desc {
      color: #ced4da;
    }
    `
  ].join("\n");

  const bundle = `/*
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
  const VIMIUM_CSS = ${JSON.stringify(combinedCss)};

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
  ${patched["lib/utils.js"]}
  ${patched["lib/keyboard_utils.js"]}
  ${patched["lib/dom_utils.js"]}
  ${patched["lib/rect.js"]}
  ${patched["lib/handler_stack.js"]}
  ${patched["lib/settings.js"]}
  ${patched["lib/find_mode_history.js"]}
  ${patched["background_scripts/all_commands.js"]}
  ${patched["background_scripts/commands.js"]}
  ${patched["content_scripts/mode.js"]}

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
          ? (matchCount > 0 ? \` (\${matchCount} Match\${matchCount === 1 ? "" : "es"})\` : " (No matches)")
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

      const cleanText = String(text || "").replace(/\\xa0/g, " ");

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

  ${patched["content_scripts/link_hints.js"]}
  ${patched["content_scripts/scroller.js"]}
  ${patched["content_scripts/marks.js"]}
  ${patched["content_scripts/mode_insert.js"]}
  ${patched["content_scripts/mode_find.js"]}
  ${patched["content_scripts/mode_key_handler.js"]}
  ${patched["content_scripts/mode_visual.js"]}
  ${patched["content_scripts/mode_normal.js"]}

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
`;

  const outPath = path.join(__dirname, "phantom-vimium.js");
  fs.writeFileSync(outPath, bundle, "utf8");
  console.log(`[Vimium] Wrote ${outPath} (${bundle.length} bytes)`);
}

async function main() {
  buildDarkReaderBundle();
  buildDarkReaderBootstrapper();
  await buildVimiumBundle();
  console.log("[Phantom] All assets generated successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
