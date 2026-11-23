/*
 * Copyright (c) 2026 ETH Zürich, IT Services
 * 
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

using Microsoft.VisualStudio.TestTools.UnitTesting;
using SafeExamBrowser.Browser.Phantom;

namespace SafeExamBrowser.Browser.UnitTests.Phantom
{
	[TestClass]
	public class PhantomTests
	{
		[TestInitialize]
		public void Initialize()
		{
			PhantomStateManager.Instance.ResetToDefaults();
		}

		[TestMethod]
		public void ConfigDefaultsMustStartDisabled()
		{
			Assert.IsFalse(PhantomConfig.DefaultDarkReaderEnabled);
			Assert.IsFalse(PhantomConfig.DefaultVimiumEnabled);
			Assert.AreEqual(100, PhantomConfig.DarkReaderBrightness);
			Assert.AreEqual(95, PhantomConfig.DarkReaderContrast);
			Assert.AreEqual(5, PhantomConfig.DarkReaderSepia);
			Assert.AreEqual(1200, PhantomConfig.ToastDurationMs);
		}

		[TestMethod]
		public void JsBridgeMustParseDictionaryAndExpandoMessagesCaseInsensitively()
		{
			dynamic expando = new System.Dynamic.ExpandoObject();
			expando.type = "Phantom";
			expando.service = "fetchCss";
			expando.requestId = "dr_42";
			expando.url = "https://www.gstatic.com/example.css";
			expando.frameUrl = "https://docs.google.com/forms/d/e/test/viewform";
			expando.isMainFrame = false;
			expando.count = 3;

			var ok = PhantomJsBridge.TryParseMessage((object) expando, null, out var parsed);

			Assert.IsTrue(ok);
			Assert.IsNotNull(parsed);
			Assert.AreEqual("Phantom", parsed.Type);
			Assert.AreEqual("fetchCss", parsed.Service);
			Assert.AreEqual("dr_42", parsed.RequestId);
			Assert.AreEqual("https://www.gstatic.com/example.css", parsed.Url);
			Assert.AreEqual("https://docs.google.com/forms/d/e/test/viewform", parsed.FrameUrl);
			Assert.AreEqual(false, parsed.IsMainFrame);
			Assert.AreEqual(3, parsed.Count);
		}

		[TestMethod]
		public void AssetProviderMustLoadEmbeddedResources()
		{
			var darkReader = PhantomAssetProvider.Instance.GetDarkReaderCore();
			var darkReaderBoot = PhantomAssetProvider.Instance.GetDarkReaderBootstrapper();
			var vimium = PhantomAssetProvider.Instance.GetVimiumBundle();
			var preFlash = PhantomAssetProvider.Instance.GetPreFlashScript();
			var toast = PhantomAssetProvider.Instance.GetToastScript("Dark Reader: ON");

			Assert.IsFalse(string.IsNullOrWhiteSpace(darkReader));
			Assert.IsTrue(darkReader.Contains("DarkReader"));
			Assert.IsTrue(darkReaderBoot.Contains("__phantomDarkReader"));
			Assert.IsTrue(darkReaderBoot.Contains("setFetchMethod"));
			Assert.IsTrue(vimium.Contains("__phantomVimium"));
			Assert.IsTrue(vimium.Contains("phantom-vimium-host"));
			Assert.IsTrue(preFlash.Contains("phantom-dr-early-preflash"));
			Assert.IsTrue(toast.Contains("phantom-toast-host"));
			Assert.IsTrue(toast.Contains("Dark Reader: ON"));

			var disabledSync = PhantomAssetProvider.Instance.GetSyncScript(false, false, "Isolated");
			Assert.IsFalse(disabledSync.Contains("DarkReader v"));
			Assert.IsTrue(disabledSync.Contains("__phantomDarkReader.sync(false"));
			Assert.IsTrue(disabledSync.Contains("__phantomVimium.sync(false"));

			var enabledSync = PhantomAssetProvider.Instance.GetSyncScript(true, true, "Block");
			Assert.IsTrue(enabledSync.Contains("__phantomDarkReader.sync(true"));
			Assert.IsTrue(enabledSync.Contains("__phantomVimium.sync(true, \"Block\")"));
		}

		[TestMethod]
		public void StateManagerMustToggleAndRestoreMasterState()
		{
			var manager = PhantomStateManager.Instance;
			var events = 0;
			manager.StateChanged += (dr, vim) => events++;

			Assert.IsFalse(manager.IsDarkReaderEnabled);
			Assert.IsFalse(manager.IsVimiumEnabled);

			// Toggle only Dark Reader ON
			Assert.IsTrue(manager.ToggleDarkReader());
			Assert.IsTrue(manager.IsDarkReaderEnabled);
			Assert.IsFalse(manager.IsVimiumEnabled);

			// Master toggle OFF remembers (DR=true, Vim=false)
			manager.ToggleAll();
			Assert.IsFalse(manager.IsDarkReaderEnabled);
			Assert.IsFalse(manager.IsVimiumEnabled);

			// Master toggle ON restores (DR=true, Vim=false)
			manager.ToggleAll();
			Assert.IsTrue(manager.IsDarkReaderEnabled);
			Assert.IsFalse(manager.IsVimiumEnabled);

			// Turn both OFF explicitly, then Master toggle ON enables both
			manager.ToggleDarkReader();
			Assert.IsFalse(manager.IsDarkReaderEnabled);
			manager.ToggleAll();
			Assert.IsTrue(manager.IsDarkReaderEnabled);
			Assert.IsTrue(manager.IsVimiumEnabled);
			Assert.AreEqual(5, events);
		}
	}
}
