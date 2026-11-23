/*
 * Copyright (c) 2026 ETH Zürich, IT Services
 * 
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using CefSharp;
using Newtonsoft.Json;
using SafeExamBrowser.Browser.Contracts.Filters;
using SafeExamBrowser.Logging.Contracts;
using SafeExamBrowser.Settings.Browser.Filter;
using Request = SafeExamBrowser.Browser.Contracts.Filters.Request;

namespace SafeExamBrowser.Browser.Phantom
{
	/// <summary>
	/// Handles CefSharp JS-to-C# messages for Phantom (cross-origin CSS fetch proxy and Vimium browser actions).
	/// </summary>
	internal sealed class PhantomJsBridge
	{
		private const int MaxCssCacheEntries = 128;
		private const string DefaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

		private static readonly TimeSpan CssCacheTtl = TimeSpan.FromMinutes(5);
		private static readonly ConcurrentDictionary<string, CachedCssEntry> cssCache = new ConcurrentDictionary<string, CachedCssEntry>(StringComparer.Ordinal);
		private static readonly HttpClient httpClient;

		private readonly BrowserWindow ownerWindow;
		private readonly ILogger logger;

		static PhantomJsBridge()
		{
			try
			{
				ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
			}
			catch
			{
			}

			var handler = new HttpClientHandler
			{
				AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
				AllowAutoRedirect = true,
				UseProxy = true,
				UseDefaultCredentials = true
			};

			httpClient = new HttpClient(handler)
			{
				Timeout = TimeSpan.FromSeconds(12)
			};
		}

		internal PhantomJsBridge(BrowserWindow ownerWindow, ILogger logger = null)
		{
			this.ownerWindow = ownerWindow;
			this.logger = logger;
		}

		internal bool TryHandleMessage(JavascriptMessageReceivedEventArgs args)
		{
			if (args == null)
			{
				return false;
			}

			if (!TryParseMessage(args.Message, () => args.ConvertMessageTo<PhantomBridgeMessage>(), out var msg))
			{
				return false;
			}

			if (!string.Equals(msg.Type, "Phantom", StringComparison.Ordinal))
			{
				return false;
			}

			var entry = PhantomStateManager.Instance.FindWindowEntry(args.Browser, ownerWindow);
			var targetBrowser = (args.Browser != null && !args.Browser.IsDisposed)
				? args.Browser
				: entry?.Control?.BrowserCore;

			switch (msg.Service)
			{
				case "fetchCss":
					HandleFetchCss(targetBrowser, entry, msg);
					return true;
				case "browserAction":
					HandleBrowserAction(entry, msg);
					return true;
				default:
					return false;
			}
		}

		internal static bool TryParseMessage(object rawMessage, Func<PhantomBridgeMessage> fallbackConverter, out PhantomBridgeMessage msg)
		{
			msg = null;

			if (rawMessage is IDictionary<string, object> dict)
			{
				var ci = new Dictionary<string, object>(dict, StringComparer.OrdinalIgnoreCase);

				msg = new PhantomBridgeMessage
				{
					Type = GetString(ci, nameof(PhantomBridgeMessage.Type)),
					Service = GetString(ci, nameof(PhantomBridgeMessage.Service)),
					RequestId = GetString(ci, nameof(PhantomBridgeMessage.RequestId)),
					Url = GetString(ci, nameof(PhantomBridgeMessage.Url)),
					Action = GetString(ci, nameof(PhantomBridgeMessage.Action)),
					Count = GetInt(ci, nameof(PhantomBridgeMessage.Count)),
					FrameUrl = GetString(ci, nameof(PhantomBridgeMessage.FrameUrl)),
					IsMainFrame = GetNullableBool(ci, nameof(PhantomBridgeMessage.IsMainFrame))
				};

				return !string.IsNullOrEmpty(msg.Type);
			}

			if (fallbackConverter != null)
			{
				try
				{
					msg = fallbackConverter();
					return msg != null && !string.IsNullOrEmpty(msg.Type);
				}
				catch
				{
				}
			}

			return false;
		}

		private void HandleFetchCss(IBrowser browser, PhantomStateManager.WindowEntry entry, PhantomBridgeMessage msg)
		{
			var effectiveLogger = logger ?? entry?.Logger;

			if (browser == null || browser.IsDisposed || string.IsNullOrWhiteSpace(msg.RequestId))
			{
				effectiveLogger?.Warn($"Ignoring Phantom fetchCss request for '{msg?.Url}': browser unavailable or RequestId missing.");
				return;
			}

			Task.Run(async () =>
			{
				object responsePayload;

				try
				{
					if (!Uri.TryCreate(msg.Url, UriKind.Absolute, out var uri) ||
						(uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
					{
						responsePayload = new { ok = false, status = 400, error = "Unsupported URL scheme." };
					}
					else if (entry?.Settings != null &&
							 entry.Settings.Filter.ProcessContentRequests &&
							 entry.RequestFilter != null &&
							 entry.RequestFilter.Process(new Request { Url = msg.Url }) == FilterResult.Block)
					{
						responsePayload = new { ok = false, status = 403, error = "Blocked by SEB content filter." };
					}
					else if (TryGetCachedCss(msg.Url, out var cached))
					{
						responsePayload = BuildSuccessPayload(cached);
					}
					else
					{
						using (var request = new HttpRequestMessage(HttpMethod.Get, uri))
						{
							request.Headers.TryAddWithoutValidation("User-Agent", DefaultUserAgent);
							request.Headers.TryAddWithoutValidation("Accept", "*/*");
							request.Headers.TryAddWithoutValidation("Accept-Language", "en-US,en;q=0.9");

							var referrer = ResolveReferrer(msg.FrameUrl, uri);
							if (referrer != null)
							{
								request.Headers.Referrer = referrer;
							}

							using (var response = await httpClient.SendAsync(request).ConfigureAwait(false))
							{
								var bytes = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
								var contentTypeHeader = response.Content.Headers.ContentType;
								var mediaType = contentTypeHeader?.MediaType;
								var contentType = contentTypeHeader?.ToString() ?? "text/css; charset=utf-8";

								if (response.IsSuccessStatusCode)
								{
									CachedCssEntry cacheEntry;

									if (IsTextContent(mediaType, uri))
									{
										var encoding = ResolveEncoding(contentTypeHeader?.CharSet);
										cacheEntry = new CachedCssEntry
										{
											ExpiresUtc = DateTime.UtcNow.Add(CssCacheTtl),
											Status = (int) response.StatusCode,
											ContentType = contentType,
											Text = encoding.GetString(bytes)
										};
									}
									else
									{
										cacheEntry = new CachedCssEntry
										{
											ExpiresUtc = DateTime.UtcNow.Add(CssCacheTtl),
											Status = (int) response.StatusCode,
											ContentType = contentType,
											Base64 = Convert.ToBase64String(bytes)
										};
									}

									StoreCachedCss(msg.Url, cacheEntry);
									responsePayload = BuildSuccessPayload(cacheEntry);
								}
								else
								{
									effectiveLogger?.Warn($"Phantom CSS fetch failed for '{msg.Url}' with HTTP {(int) response.StatusCode}.");
									responsePayload = new
									{
										ok = false,
										status = (int) response.StatusCode,
										error = $"HTTP {(int) response.StatusCode}"
									};
								}
							}
						}
					}
				}
				catch (Exception ex)
				{
					effectiveLogger?.Error($"Phantom CSS fetch exception for '{msg.Url}'.", ex);
					responsePayload = new { ok = false, status = 502, error = ex.Message };
				}

				try
				{
					var reqIdJson = JsonConvert.SerializeObject(msg.RequestId);
					var payloadJson = JsonConvert.SerializeObject(responsePayload);
					var script = $"window.__phantomDarkReader && window.__phantomDarkReader.__onCssFetched({reqIdJson}, {payloadJson});";
					DispatchCssResponse(browser, msg, script, effectiveLogger);
				}
				catch (Exception ex)
				{
					effectiveLogger?.Error($"Phantom CSS response serialization failed for '{msg.Url}'.", ex);
				}
			});
		}

		private static object BuildSuccessPayload(CachedCssEntry entry)
		{
			if (entry.Text != null)
			{
				return new
				{
					ok = true,
					status = entry.Status,
					contentType = entry.ContentType,
					text = entry.Text
				};
			}

			return new
			{
				ok = true,
				status = entry.Status,
				contentType = entry.ContentType,
				base64 = entry.Base64
			};
		}

		private static void DispatchCssResponse(IBrowser browser, PhantomBridgeMessage msg, string script, ILogger logger)
		{
			if (browser == null || browser.IsDisposed)
			{
				logger?.Warn($"Cannot dispatch CSS response for '{msg.Url}': browser unavailable or disposed.");
				return;
			}

			var dispatched = false;

			try
			{
				if (msg.IsMainFrame == true)
				{
					var mainFrame = browser.MainFrame;
					if (mainFrame != null && mainFrame.IsValid && !mainFrame.IsDisposed)
					{
						mainFrame.ExecuteJavaScriptAsync(script);
						dispatched = true;
					}
				}

				if (!dispatched)
				{
					var candidateFrames = new List<IFrame>();
					var frames = browser.GetAllFrames();

					if (frames != null)
					{
						foreach (var frame in frames)
						{
							if (frame != null && frame.IsValid && !frame.IsDisposed)
							{
								candidateFrames.Add(frame);
							}
						}
					}

					if (!string.IsNullOrEmpty(msg.FrameUrl))
					{
						foreach (var frame in candidateFrames)
						{
							if (string.Equals(frame.Url, msg.FrameUrl, StringComparison.Ordinal))
							{
								frame.ExecuteJavaScriptAsync(script);
								dispatched = true;
							}
						}
					}

					if (!dispatched && msg.IsMainFrame == false)
					{
						foreach (var frame in candidateFrames)
						{
							if (!frame.IsMain)
							{
								frame.ExecuteJavaScriptAsync(script);
								dispatched = true;
							}
						}
					}

					if (!dispatched)
					{
						foreach (var frame in candidateFrames)
						{
							frame.ExecuteJavaScriptAsync(script);
							dispatched = true;
						}
					}
				}
			}
			catch (Exception ex)
			{
				logger?.Error($"Failed to dispatch CSS response for '{msg.Url}'.", ex);
			}

			if (!dispatched)
			{
				logger?.Warn($"No valid frame found to deliver CSS response for '{msg.Url}'.");
			}
		}

		private static bool TryGetCachedCss(string url, out CachedCssEntry entry)
		{
			if (cssCache.TryGetValue(url, out entry))
			{
				if (DateTime.UtcNow <= entry.ExpiresUtc)
				{
					return true;
				}

				cssCache.TryRemove(url, out _);
			}

			entry = null;
			return false;
		}

		private static void StoreCachedCss(string url, CachedCssEntry entry)
		{
			if (cssCache.Count >= MaxCssCacheEntries)
			{
				var now = DateTime.UtcNow;

				foreach (var pair in cssCache)
				{
					if (now > pair.Value.ExpiresUtc)
					{
						cssCache.TryRemove(pair.Key, out _);
					}
				}

				while (cssCache.Count >= MaxCssCacheEntries)
				{
					var oldest = cssCache.OrderBy(p => p.Value.ExpiresUtc).FirstOrDefault();
					if (string.IsNullOrEmpty(oldest.Key))
					{
						break;
					}

					cssCache.TryRemove(oldest.Key, out _);
				}
			}

			cssCache[url] = entry;
		}

		private static Uri ResolveReferrer(string frameUrl, Uri targetUri)
		{
			if (Uri.TryCreate(frameUrl, UriKind.Absolute, out var frameUri) &&
				(frameUri.Scheme == Uri.UriSchemeHttp || frameUri.Scheme == Uri.UriSchemeHttps))
			{
				return new Uri(frameUri.GetLeftPart(UriPartial.Authority) + "/");
			}

			if (Uri.TryCreate(targetUri.GetLeftPart(UriPartial.Authority) + "/", UriKind.Absolute, out var originUri))
			{
				return originUri;
			}

			return null;
		}

		private static bool IsTextContent(string mediaType, Uri uri)
		{
			if (!string.IsNullOrWhiteSpace(mediaType))
			{
				if (mediaType.StartsWith("text/", StringComparison.OrdinalIgnoreCase) ||
					mediaType.IndexOf("css", StringComparison.OrdinalIgnoreCase) >= 0 ||
					mediaType.IndexOf("javascript", StringComparison.OrdinalIgnoreCase) >= 0 ||
					mediaType.IndexOf("ecmascript", StringComparison.OrdinalIgnoreCase) >= 0 ||
					mediaType.IndexOf("json", StringComparison.OrdinalIgnoreCase) >= 0 ||
					mediaType.IndexOf("xml", StringComparison.OrdinalIgnoreCase) >= 0 ||
					mediaType.IndexOf("svg", StringComparison.OrdinalIgnoreCase) >= 0)
				{
					return true;
				}

				return false;
			}

			var path = uri?.AbsolutePath ?? string.Empty;
			return path.EndsWith(".css", StringComparison.OrdinalIgnoreCase) ||
				   path.EndsWith(".svg", StringComparison.OrdinalIgnoreCase) ||
				   path.EndsWith(".txt", StringComparison.OrdinalIgnoreCase);
		}

		private static Encoding ResolveEncoding(string charset)
		{
			if (!string.IsNullOrWhiteSpace(charset))
			{
				try
				{
					return Encoding.GetEncoding(charset.Trim().Trim('"'));
				}
				catch
				{
				}
			}

			return Encoding.UTF8;
		}

		private static string GetString(IDictionary<string, object> dict, string key)
		{
			return dict.TryGetValue(key, out var val) && val != null ? Convert.ToString(val) : null;
		}

		private static int GetInt(IDictionary<string, object> dict, string key)
		{
			if (!dict.TryGetValue(key, out var val) || val == null)
			{
				return 0;
			}

			try
			{
				return Convert.ToInt32(val);
			}
			catch
			{
				return 0;
			}
		}

		private static bool? GetNullableBool(IDictionary<string, object> dict, string key)
		{
			if (!dict.TryGetValue(key, out var val) || val == null)
			{
				return null;
			}

			if (val is bool b)
			{
				return b;
			}

			if (bool.TryParse(Convert.ToString(val), out var parsed))
			{
				return parsed;
			}

			return null;
		}

		private void HandleBrowserAction(PhantomStateManager.WindowEntry entry, PhantomBridgeMessage msg)
		{
			if (entry == null || string.IsNullOrWhiteSpace(msg.Action))
			{
				return;
			}

			var count = msg.Count > 0 ? msg.Count : 1;

			switch (msg.Action)
			{
				case "back":
					if (entry.WindowSettings?.AllowBackwardNavigation == true && entry.Window.Control.CanNavigateBackwards)
					{
						entry.Window.Control.NavigateBackwards();
					}
					break;
				case "forward":
					if (entry.WindowSettings?.AllowForwardNavigation == true && entry.Window.Control.CanNavigateForwards)
					{
						entry.Window.Control.NavigateForwards();
					}
					break;
				case "reload":
					if (entry.WindowSettings?.AllowReloading == true)
					{
						Task.Run(() => entry.Window.RequestReload());
					}
					break;
				case "nextWindow":
					PhantomStateManager.Instance.ActivateRelativeWindow(entry.Window, count);
					break;
				case "prevWindow":
					PhantomStateManager.Instance.ActivateRelativeWindow(entry.Window, -count);
					break;
				case "firstWindow":
					PhantomStateManager.Instance.ActivateEdgeWindow(true);
					break;
				case "lastWindow":
					PhantomStateManager.Instance.ActivateEdgeWindow(false);
					break;
				case "closeSecondaryWindow":
					PhantomStateManager.Instance.CloseSecondaryWindow(entry.Window);
					break;
				case "openUrlInNewWindow":
					PhantomStateManager.Instance.OpenUrlInNewWindow(entry, msg.Url);
					break;
				case "openUrlInCurrentWindow":
					PhantomStateManager.Instance.OpenUrlInCurrentWindow(entry, msg.Url);
					break;
				case "nextFrame":
					PhantomStateManager.Instance.FocusNextFrame(entry, count);
					break;
			}
		}

		internal sealed class PhantomBridgeMessage
		{
			public string Type { get; set; }
			public string Service { get; set; }
			public string RequestId { get; set; }
			public string Url { get; set; }
			public string Action { get; set; }
			public int Count { get; set; }
			public string FrameUrl { get; set; }
			public bool? IsMainFrame { get; set; }
		}

		private sealed class CachedCssEntry
		{
			public DateTime ExpiresUtc { get; set; }
			public int Status { get; set; }
			public string ContentType { get; set; }
			public string Text { get; set; }
			public string Base64 { get; set; }
		}
	}
}
