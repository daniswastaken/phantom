/*
 * Copyright (c) 2026 ETH Zürich, IT Services
 * 
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

using System;
using System.IO;
using System.Reflection;
using System.Text;
using Newtonsoft.Json;

namespace SafeExamBrowser.Browser.Phantom
{
	/// <summary>
	/// Loads embedded Phantom JS/CSS assets strictly from assembly resources with zero network calls.
	/// </summary>
	public sealed class PhantomAssetProvider
	{
		private const string ASSET_NAMESPACE = "SafeExamBrowser.Browser.Phantom.Assets";

		private static readonly Lazy<PhantomAssetProvider> instance = new Lazy<PhantomAssetProvider>(() => new PhantomAssetProvider());

		private readonly Lazy<string> darkReaderCore;
		private readonly Lazy<string> darkReaderBootstrapper;
		private readonly Lazy<string> vimiumBundle;

		public static PhantomAssetProvider Instance => instance.Value;

		private PhantomAssetProvider()
		{
			darkReaderCore = new Lazy<string>(() => LoadEmbeddedResource("darkreader.min.js"));
			darkReaderBootstrapper = new Lazy<string>(() => LoadEmbeddedResource("phantom-darkreader.js"));
			vimiumBundle = new Lazy<string>(() => LoadEmbeddedResource("phantom-vimium.js"));
		}

		public string GetDarkReaderCore() => darkReaderCore.Value;
		public string GetDarkReaderBootstrapper() => darkReaderBootstrapper.Value;
		public string GetVimiumBundle() => vimiumBundle.Value;

		/// <summary>
		/// Lightweight synchronous pre-flash script executed at earliest context creation to prevent white flashes.
		/// </summary>
		public string GetPreFlashScript()
		{
			return @"
(function () {
  try {
    if (window.__phantomDarkReader && window.__phantomDarkReader.isEnabled()) {
      return;
    }
    var inject = function () {
      var target = document.head || document.documentElement;
      if (!target) { return false; }
      if (!document.getElementById('phantom-dr-early-preflash')) {
        var style = document.createElement('style');
        style.id = 'phantom-dr-early-preflash';
        style.textContent = 'html, body { background-color: #181a1b !important; color: #e8e6e3 !important; color-scheme: dark !important; }';
        target.appendChild(style);
      }
      return true;
    };
    if (!inject() && typeof MutationObserver !== 'undefined') {
      var obs = new MutationObserver(function () {
        if (inject()) { obs.disconnect(); }
      });
      obs.observe(document, { childList: true, subtree: true });
    }
  } catch (e) {}
})();";
		}

		/// <summary>
		/// Builds an idempotent synchronization script that lazily initializes only what is enabled
		/// and applies the target states to Dark Reader and Vimium in the frame.
		/// </summary>
		public string GetSyncScript(bool darkReaderEnabled, bool vimiumEnabled, string clipboardPolicy)
		{
			var sb = new StringBuilder();
			var themeJson = JsonConvert.SerializeObject(new
			{
				mode = 1,
				brightness = PhantomConfig.DarkReaderBrightness,
				contrast = PhantomConfig.DarkReaderContrast,
				sepia = PhantomConfig.DarkReaderSepia
			});
			var policyJson = JsonConvert.SerializeObject(clipboardPolicy ?? "Isolated");

			if (darkReaderEnabled)
			{
				sb.AppendLine("try {");
				sb.AppendLine("  if (!window.DarkReader) {");
				sb.AppendLine(darkReaderCore.Value);
				sb.AppendLine("  }");
				sb.AppendLine("  if (!window.__phantomDarkReader) {");
				sb.AppendLine(darkReaderBootstrapper.Value);
				sb.AppendLine("  }");
				sb.AppendLine($"  window.__phantomDarkReader && window.__phantomDarkReader.sync(true, {themeJson});");
				sb.AppendLine("} catch (e) { try { console.error('[Phantom DarkReader]', e); } catch (_) {} }");
			}
			else
			{
				sb.AppendLine($"try {{ if (window.__phantomDarkReader) {{ window.__phantomDarkReader.sync(false, {themeJson}); }} }} catch (e) {{ try {{ console.error('[Phantom DarkReader]', e); }} catch (_) {{}} }}");
			}

			if (vimiumEnabled)
			{
				sb.AppendLine("try {");
				sb.AppendLine("  if (!window.__phantomVimium) {");
				sb.AppendLine(vimiumBundle.Value);
				sb.AppendLine("  }");
				sb.AppendLine($"  window.__phantomVimium && window.__phantomVimium.sync(true, {policyJson});");
				sb.AppendLine("} catch (e) { try { console.error('[Phantom Vimium]', e); } catch (_) {} }");
			}
			else
			{
				sb.AppendLine($"try {{ if (window.__phantomVimium) {{ window.__phantomVimium.sync(false, {policyJson}); }} }} catch (e) {{ try {{ console.error('[Phantom Vimium]', e); }} catch (_) {{}} }}");
			}

			return sb.ToString();
		}

		/// <summary>
		/// Renders a minimal, pointer-events-none bottom-right toast in an isolated Shadow DOM container.
		/// </summary>
		public string GetToastScript(string message, int durationMs = PhantomConfig.ToastDurationMs)
		{
			var msgJson = JsonConvert.SerializeObject(message ?? string.Empty);

			return $@"
(function () {{
  try {{
    var root = document.documentElement || document.body;
    if (!root) return;
    var host = document.getElementById('phantom-toast-host');
    var shadow = window.__phantomToastShadow;
    if (!host || !shadow) {{
      if (host && host.parentNode) {{ host.parentNode.removeChild(host); }}
      host = document.createElement('div');
      host.id = 'phantom-toast-host';
      host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;pointer-events:none;';
      shadow = host.attachShadow({{ mode: 'closed' }});
      window.__phantomToastShadow = shadow;
      root.appendChild(host);
    }}
    while (shadow.firstChild) {{ shadow.removeChild(shadow.firstChild); }}
    var box = document.createElement('div');
    box.textContent = {msgJson};
    box.style.cssText = 'background:rgba(24,26,30,0.92);color:#f1f3f5;border:1px solid rgba(255,255,255,0.16);border-radius:6px;padding:7px 13px;font-family:""Segoe UI"",Helvetica,Arial,sans-serif;font-size:12px;font-weight:600;letter-spacing:0.02em;box-shadow:0 4px 16px rgba(0,0,0,0.4);opacity:1;transition:opacity 200ms ease;pointer-events:none;white-space:nowrap;';
    shadow.appendChild(box);
    if (window.__phantomToastTimer) {{ clearTimeout(window.__phantomToastTimer); }}
    window.__phantomToastTimer = setTimeout(function () {{
      try {{
        box.style.opacity = '0';
        setTimeout(function () {{
          try {{
            if (host && host.parentNode) host.parentNode.removeChild(host);
            if (window.__phantomToastShadow === shadow) window.__phantomToastShadow = null;
          }} catch (e) {{}}
        }}, 220);
      }} catch (e) {{}}
    }}, {durationMs});
  }} catch (e) {{}}
}})();";
		}

		private static string LoadEmbeddedResource(string fileName)
		{
			var assembly = Assembly.GetAssembly(typeof(PhantomAssetProvider));
			var resourceName = $"{ASSET_NAMESPACE}.{fileName}";

			using (var stream = assembly.GetManifestResourceStream(resourceName))
			{
				if (stream == null)
				{
					throw new FileNotFoundException($"Embedded Phantom asset '{resourceName}' was not found.");
				}

				using (var reader = new StreamReader(stream, Encoding.UTF8))
				{
					return reader.ReadToEnd();
				}
			}
		}
	}
}
