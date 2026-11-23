/*
 * Copyright (c) 2026 ETH Zürich, IT Services
 * 
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using CefSharp;
using SafeExamBrowser.Browser.Contracts.Filters;
using SafeExamBrowser.Browser.Wrapper;
using SafeExamBrowser.Logging.Contracts;
using SafeExamBrowser.Settings.Browser;
using SafeExamBrowser.Settings.Browser.Filter;
using BrowserSettings = SafeExamBrowser.Settings.Browser.BrowserSettings;
using Request = SafeExamBrowser.Browser.Contracts.Filters.Request;

namespace SafeExamBrowser.Browser.Phantom
{
	/// <summary>
	/// Thread-safe singleton managing Phantom extension states and synchronizing all active windows and frames.
	/// </summary>
	public sealed class PhantomStateManager
	{
		private static readonly Lazy<PhantomStateManager> instance = new Lazy<PhantomStateManager>(() => new PhantomStateManager());

		private readonly object syncRoot = new object();
		private readonly List<WindowEntry> windows = new List<WindowEntry>();

		private bool isDarkReaderEnabled = PhantomConfig.DefaultDarkReaderEnabled;
		private bool isVimiumEnabled = PhantomConfig.DefaultVimiumEnabled;
		private bool? savedDarkReaderState;
		private bool? savedVimiumState;
		private string clipboardPolicyOverride;

		public static PhantomStateManager Instance => instance.Value;

		public event Action<bool, bool> StateChanged;

		public bool IsDarkReaderEnabled
		{
			get { lock (syncRoot) { return isDarkReaderEnabled; } }
		}

		public bool IsVimiumEnabled
		{
			get { lock (syncRoot) { return isVimiumEnabled; } }
		}

		private PhantomStateManager()
		{
		}

		public bool ToggleDarkReader()
		{
			bool enabled;
			bool vimium;

			lock (syncRoot)
			{
				isDarkReaderEnabled = !isDarkReaderEnabled;
				savedDarkReaderState = null;
				savedVimiumState = null;
				enabled = isDarkReaderEnabled;
				vimium = isVimiumEnabled;
			}

			BroadcastState(enabled, vimium);
			BroadcastToast($"Dark Reader: {(enabled ? "ON" : "OFF")}");
			StateChanged?.Invoke(enabled, vimium);

			return enabled;
		}

		public bool ToggleVimium()
		{
			bool darkReader;
			bool enabled;

			lock (syncRoot)
			{
				isVimiumEnabled = !isVimiumEnabled;
				savedDarkReaderState = null;
				savedVimiumState = null;
				darkReader = isDarkReaderEnabled;
				enabled = isVimiumEnabled;
			}

			BroadcastState(darkReader, enabled);
			BroadcastToast($"Vimium: {(enabled ? "ON" : "OFF")}");
			StateChanged?.Invoke(darkReader, enabled);

			return enabled;
		}

		public void ToggleAll()
		{
			bool darkReader;
			bool vimium;

			lock (syncRoot)
			{
				if (isDarkReaderEnabled || isVimiumEnabled)
				{
					savedDarkReaderState = isDarkReaderEnabled;
					savedVimiumState = isVimiumEnabled;
					isDarkReaderEnabled = false;
					isVimiumEnabled = false;
				}
				else
				{
					var restoreDarkReader = savedDarkReaderState ?? true;
					var restoreVimium = savedVimiumState ?? true;

					if (!restoreDarkReader && !restoreVimium)
					{
						restoreDarkReader = true;
						restoreVimium = true;
					}

					isDarkReaderEnabled = restoreDarkReader;
					isVimiumEnabled = restoreVimium;
					savedDarkReaderState = null;
					savedVimiumState = null;
				}

				darkReader = isDarkReaderEnabled;
				vimium = isVimiumEnabled;
			}

			BroadcastState(darkReader, vimium);
			BroadcastToast($"Dark Reader: {(darkReader ? "ON" : "OFF")}  •  Vimium: {(vimium ? "ON" : "OFF")}");
			StateChanged?.Invoke(darkReader, vimium);
		}

		/// <summary>
		/// Resets internal runtime state to configured defaults (primarily for deterministic testing).
		/// </summary>
		internal void ResetToDefaults()
		{
			lock (syncRoot)
			{
				isDarkReaderEnabled = PhantomConfig.DefaultDarkReaderEnabled;
				isVimiumEnabled = PhantomConfig.DefaultVimiumEnabled;
				savedDarkReaderState = null;
				savedVimiumState = null;
			}
		}

		internal void RegisterWindow(
			BrowserWindow window,
			ICefSharpControl control,
			IRequestFilter requestFilter,
			BrowserSettings settings,
			WindowSettings windowSettings,
			ILogger logger)
		{
			if (window == null || control == null)
			{
				return;
			}

			lock (syncRoot)
			{
				windows.RemoveAll(w => w.Control.IsDisposed || ReferenceEquals(w.Window, window));
				windows.Add(new WindowEntry
				{
					Window = window,
					Control = control,
					RequestFilter = requestFilter,
					Settings = settings,
					WindowSettings = windowSettings,
					Logger = logger
				});
			}
		}

		internal void UnregisterWindow(BrowserWindow window)
		{
			if (window == null)
			{
				return;
			}

			lock (syncRoot)
			{
				windows.RemoveAll(w => w.Control.IsDisposed || ReferenceEquals(w.Window, window));
			}
		}

		public void OnContextCreated(IFrame frame)
		{
			if (frame == null || !frame.IsValid)
			{
				return;
			}

			bool darkReader;
			bool vimium;

			lock (syncRoot)
			{
				darkReader = isDarkReaderEnabled;
				vimium = isVimiumEnabled;
			}

			try
			{
				if (darkReader)
				{
					frame.ExecuteJavaScriptAsync(PhantomAssetProvider.Instance.GetPreFlashScript());
				}

				if (darkReader || vimium)
				{
					frame.ExecuteJavaScriptAsync(PhantomAssetProvider.Instance.GetSyncScript(darkReader, vimium, ResolveClipboardPolicy(null)));
				}
			}
			catch
			{
				// Ignore disposed/navigated frame exceptions.
			}
		}

		public void SyncFrame(IFrame frame)
		{
			if (frame == null || !frame.IsValid)
			{
				return;
			}

			bool darkReader;
			bool vimium;

			lock (syncRoot)
			{
				darkReader = isDarkReaderEnabled;
				vimium = isVimiumEnabled;
			}

			try
			{
				var script = PhantomAssetProvider.Instance.GetSyncScript(darkReader, vimium, ResolveClipboardPolicy(null));
				frame.ExecuteJavaScriptAsync(script);
			}
			catch
			{
				// Ignore disposed/navigated frame exceptions.
			}
		}

		internal WindowEntry FindWindowEntry(IBrowser browser, BrowserWindow fallbackWindow)
		{
			lock (syncRoot)
			{
				windows.RemoveAll(w => w.Control.IsDisposed);

				if (browser != null)
				{
					var match = windows.FirstOrDefault(w =>
						w.Control.IsBrowserInitialized &&
						w.Control.BrowserCore != null &&
						w.Control.BrowserCore.Identifier == browser.Identifier);

					if (match != null)
					{
						return match;
					}
				}

				if (fallbackWindow != null)
				{
					return windows.FirstOrDefault(w => ReferenceEquals(w.Window, fallbackWindow));
				}

				return windows.FirstOrDefault();
			}
		}

		internal void ActivateRelativeWindow(BrowserWindow currentWindow, int offset)
		{
			BrowserWindow target = null;

			lock (syncRoot)
			{
				windows.RemoveAll(w => w.Control.IsDisposed);
				if (windows.Count <= 1)
				{
					return;
				}

				var index = windows.FindIndex(w => ReferenceEquals(w.Window, currentWindow));
				if (index < 0)
				{
					index = 0;
				}

				var nextIndex = ((index + offset) % windows.Count + windows.Count) % windows.Count;
				target = windows[nextIndex].Window;
			}

			target?.Activate();
		}

		internal void ActivateEdgeWindow(bool first)
		{
			BrowserWindow target = null;

			lock (syncRoot)
			{
				windows.RemoveAll(w => w.Control.IsDisposed);
				if (windows.Count == 0)
				{
					return;
				}

				target = first ? windows[0].Window : windows[windows.Count - 1].Window;
			}

			target?.Activate();
		}

		internal void CloseSecondaryWindow(BrowserWindow currentWindow)
		{
			if (currentWindow == null || currentWindow.IsMainWindow)
			{
				return;
			}

			currentWindow.Close();
		}

		internal void OpenUrlInNewWindow(WindowEntry entry, string targetUrl)
		{
			if (entry == null || string.IsNullOrWhiteSpace(targetUrl))
			{
				return;
			}

			if (!Uri.TryCreate(targetUrl, UriKind.Absolute, out var newUri) ||
				(newUri.Scheme != Uri.UriSchemeHttp && newUri.Scheme != Uri.UriSchemeHttps))
			{
				return;
			}

			var settings = entry.Settings;
			if (IsQuitUrl(settings, targetUrl))
			{
				entry.Logger?.Info("Phantom blocked opening quit URL in a new window.");
				return;
			}

			if (settings != null && settings.Filter.ProcessMainRequests && entry.RequestFilter != null)
			{
				if (entry.RequestFilter.Process(new Request { Url = targetUrl }) == FilterResult.Block)
				{
					entry.Logger?.Info("Phantom blocked new window URL due to SEB URL filter.");
					return;
				}
			}

			var validCurrentUri = Uri.TryCreate(entry.Control.Address, UriKind.Absolute, out var currentUri);
			var sameHost = validCurrentUri && string.Equals(currentUri.Host, newUri.Host, StringComparison.OrdinalIgnoreCase);
			var policy = settings?.PopupPolicy ?? PopupPolicy.Block;

			switch (policy)
			{
				case PopupPolicy.Allow:
				case PopupPolicy.AllowSameHost when sameHost:
				{
					var mainEntry = GetMainWindowEntry() ?? entry;
					var mainFrame = mainEntry.Control.BrowserCore?.MainFrame;
					if (mainFrame != null && mainFrame.IsValid)
					{
						var urlLiteral = Newtonsoft.Json.JsonConvert.SerializeObject(targetUrl);
						mainFrame.ExecuteJavaScriptAsync($"window.open({urlLiteral}, '_blank');");
					}
					break;
				}
				case PopupPolicy.AllowSameWindow:
				case PopupPolicy.AllowSameHostAndWindow when sameHost:
					entry.Window.Control.NavigateTo(targetUrl);
					break;
			}
		}

		internal void OpenUrlInCurrentWindow(WindowEntry entry, string targetUrl)
		{
			if (entry == null || string.IsNullOrWhiteSpace(targetUrl))
			{
				return;
			}

			if (!Uri.TryCreate(targetUrl, UriKind.Absolute, out var newUri) ||
				(newUri.Scheme != Uri.UriSchemeHttp && newUri.Scheme != Uri.UriSchemeHttps))
			{
				return;
			}

			var settings = entry.Settings;
			if (settings != null && settings.Filter.ProcessMainRequests && entry.RequestFilter != null)
			{
				if (entry.RequestFilter.Process(new Request { Url = targetUrl }) == FilterResult.Block)
				{
					entry.Logger?.Info("Phantom blocked current-window URL due to SEB URL filter.");
					return;
				}
			}

			entry.Window.Control.NavigateTo(targetUrl);
		}

		internal void FocusNextFrame(WindowEntry entry, int count)
		{
			var browser = entry?.Control?.BrowserCore;
			if (browser == null || browser.IsDisposed)
			{
				return;
			}

			var frames = browser.GetAllFrames()?.Where(f => f != null && f.IsValid).ToList();
			if (frames == null || frames.Count <= 1)
			{
				return;
			}

			var focusedIndex = frames.FindIndex(f => f.IsFocused);
			if (focusedIndex < 0)
			{
				focusedIndex = 0;
			}

			var nextIndex = ((focusedIndex + count) % frames.Count + frames.Count) % frames.Count;
			try
			{
				frames[nextIndex].ExecuteJavaScriptAsync("try { window.focus(); } catch (e) {}");
			}
			catch
			{
			}
		}

		private void BroadcastState(bool darkReader, bool vimium)
		{
			List<WindowEntry> snapshot;
			lock (syncRoot)
			{
				windows.RemoveAll(w => w.Control.IsDisposed);
				snapshot = new List<WindowEntry>(windows);
			}

			foreach (var entry in snapshot)
			{
				try
				{
					entry.Window?.UpdatePhantomToolbarState(darkReader, vimium);

					var policy = ResolveClipboardPolicy(entry.Settings);
					var script = PhantomAssetProvider.Instance.GetSyncScript(darkReader, vimium, policy);
					var frames = entry.Control.BrowserCore?.GetAllFrames();

					if (frames != null)
					{
						foreach (var frame in frames)
						{
							if (frame != null && frame.IsValid)
							{
								frame.ExecuteJavaScriptAsync(script);
							}
						}
					}
				}
				catch (Exception e)
				{
					entry.Logger?.Warn($"Failed to broadcast Phantom state to window #{entry.Window?.Id}: {e.Message}");
				}
			}
		}

		private void BroadcastToast(string message)
		{
			List<WindowEntry> snapshot;
			lock (syncRoot)
			{
				windows.RemoveAll(w => w.Control.IsDisposed);
				snapshot = new List<WindowEntry>(windows);
			}

			var script = PhantomAssetProvider.Instance.GetToastScript(message);

			foreach (var entry in snapshot)
			{
				try
				{
					var mainFrame = entry.Control.BrowserCore?.MainFrame;
					if (mainFrame != null && mainFrame.IsValid)
					{
						mainFrame.ExecuteJavaScriptAsync(script);
					}
				}
				catch
				{
				}
			}
		}

		private WindowEntry GetMainWindowEntry()
		{
			lock (syncRoot)
			{
				return windows.FirstOrDefault(w => !w.Control.IsDisposed && w.Window.IsMainWindow);
			}
		}

		public void SetClipboardPolicy(string policy)
		{
			lock (syncRoot)
			{
				clipboardPolicyOverride = policy;
			}
		}

		private string ResolveClipboardPolicy(BrowserSettings settingsOverride)
		{
			lock (syncRoot)
			{
				if (!string.IsNullOrEmpty(clipboardPolicyOverride))
				{
					return clipboardPolicyOverride;
				}
			}

			var settings = settingsOverride;
			if (settings == null)
			{
				lock (syncRoot)
				{
					settings = windows.FirstOrDefault()?.Settings;
				}
			}

			if (settings == null)
			{
				return "Isolated";
			}

			return settings.UseIsolatedClipboard ? "Isolated" : "Allow";
		}

		private static bool IsQuitUrl(BrowserSettings settings, string url)
		{
			if (settings == null || string.IsNullOrWhiteSpace(settings.QuitUrl))
			{
				return false;
			}

			var pattern = $"^{Regex.Escape(settings.QuitUrl.TrimEnd('/'))}/?$";
			return Regex.IsMatch(url, pattern, RegexOptions.IgnoreCase);
		}

		internal sealed class WindowEntry
		{
			public BrowserWindow Window { get; set; }
			public ICefSharpControl Control { get; set; }
			public IRequestFilter RequestFilter { get; set; }
			public BrowserSettings Settings { get; set; }
			public WindowSettings WindowSettings { get; set; }
			public ILogger Logger { get; set; }
		}
	}
}
