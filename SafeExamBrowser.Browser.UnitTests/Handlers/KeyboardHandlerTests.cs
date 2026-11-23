/*
 * Copyright (c) 2026 ETH Zürich, IT Services
 * 
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

using System.Windows.Forms;
using CefSharp;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using SafeExamBrowser.Browser.Handlers;
using SafeExamBrowser.Browser.Phantom;

namespace SafeExamBrowser.Browser.UnitTests.Handlers
{
	[TestClass]
	public class KeyboardHandlerTests
	{
		private KeyboardHandler sut;

		[TestInitialize]
		public void Initialize()
		{
			PhantomStateManager.Instance.ResetToDefaults();
			sut = new KeyboardHandler();
		}

		[TestMethod]
		public void MustDetectFindCommand()
		{
			var findRequested = false;

			sut.FindRequested += () => findRequested = true;

			var handled = sut.OnKeyEvent(default(IWebBrowser), default(IBrowser), KeyType.KeyUp, (int) Keys.F, default(int), CefEventFlags.ControlDown, default(bool));

			Assert.IsTrue(findRequested);
			Assert.IsFalse(handled);

			findRequested = false;
			handled = sut.OnKeyEvent(default(IWebBrowser), default(IBrowser), default(KeyType), default(int), default(int), CefEventFlags.ControlDown, default(bool));

			Assert.IsFalse(findRequested);
			Assert.IsFalse(handled);
		}

		[TestMethod]
		public void MustDetectHomeNavigationCommand()
		{
			var homeRequested = false;

			sut.HomeNavigationRequested += () => homeRequested = true;

			var handled = sut.OnKeyEvent(default(IWebBrowser), default(IBrowser), KeyType.KeyUp, (int) Keys.Home, default(int), default(CefEventFlags), default(bool));

			Assert.IsTrue(homeRequested);
			Assert.IsFalse(handled);

			homeRequested = false;
			handled = sut.OnKeyEvent(default(IWebBrowser), default(IBrowser), default(KeyType), default(int), default(int), default(CefEventFlags), default(bool));

			Assert.IsFalse(homeRequested);
			Assert.IsFalse(handled);
		}

		[TestMethod]
		public void MustDetectReloadCommand()
		{
			var isShortcut = default(bool);
			var reloadRequested = false;

			sut.ReloadRequested += () => reloadRequested = true;

			var handled = sut.OnPreKeyEvent(default(IWebBrowser), default(IBrowser), KeyType.KeyUp, (int) Keys.F5, default(int), default(CefEventFlags), default(bool), ref isShortcut);

			Assert.IsTrue(reloadRequested);
			Assert.IsTrue(handled);

			reloadRequested = false;
			handled = sut.OnPreKeyEvent(default(IWebBrowser), default(IBrowser), default(KeyType), default(int), default(int), default(CefEventFlags), default(bool), ref isShortcut);

			Assert.IsFalse(reloadRequested);
			Assert.IsFalse(handled);
		}

		[TestMethod]
		public void MustDetectZoomInCommand()
		{
			var zoomIn = false;
			var zoomOut = false;
			var zoomReset = false;

			sut.ZoomInRequested += () => zoomIn = true;
			sut.ZoomOutRequested += () => zoomOut = true;
			sut.ZoomResetRequested += () => zoomReset = true;

			var handled = sut.OnKeyEvent(default(IWebBrowser), default(IBrowser), KeyType.KeyUp, (int) Keys.Add, default(int), CefEventFlags.ControlDown, false);

			Assert.IsFalse(handled);
			Assert.IsTrue(zoomIn);
			Assert.IsFalse(zoomOut);
			Assert.IsFalse(zoomReset);

			zoomIn = false;
			handled = sut.OnKeyEvent(default(IWebBrowser), default(IBrowser), KeyType.KeyUp, (int) Keys.D1, default(int), CefEventFlags.ControlDown | CefEventFlags.ShiftDown, false);

			Assert.IsFalse(handled);
			Assert.IsTrue(zoomIn);
			Assert.IsFalse(zoomOut);
			Assert.IsFalse(zoomReset);
		}

		[TestMethod]
		public void MustDetectZoomOutCommand()
		{
			var zoomIn = false;
			var zoomOut = false;
			var zoomReset = false;

			sut.ZoomInRequested += () => zoomIn = true;
			sut.ZoomOutRequested += () => zoomOut = true;
			sut.ZoomResetRequested += () => zoomReset = true;

			var handled = sut.OnKeyEvent(default(IWebBrowser), default(IBrowser), KeyType.KeyUp, (int) Keys.Subtract, default(int), CefEventFlags.ControlDown, false);

			Assert.IsFalse(handled);
			Assert.IsFalse(zoomIn);
			Assert.IsTrue(zoomOut);
			Assert.IsFalse(zoomReset);

			zoomOut = false;
			handled = sut.OnKeyEvent(default(IWebBrowser), default(IBrowser), KeyType.KeyUp, (int) Keys.OemMinus, default(int), CefEventFlags.ControlDown, false);

			Assert.IsFalse(handled);
			Assert.IsFalse(zoomIn);
			Assert.IsTrue(zoomOut);
			Assert.IsFalse(zoomReset);
		}

		[TestMethod]
		public void MustDetectZoomResetCommand()
		{
			var zoomIn = false;
			var zoomOut = false;
			var zoomReset = false;

			sut.ZoomInRequested += () => zoomIn = true;
			sut.ZoomOutRequested += () => zoomOut = true;
			sut.ZoomResetRequested += () => zoomReset = true;

			var handled = sut.OnKeyEvent(default(IWebBrowser), default(IBrowser), KeyType.KeyUp, (int) Keys.D0, default(int), CefEventFlags.ControlDown, false);

			Assert.IsFalse(handled);
			Assert.IsFalse(zoomIn);
			Assert.IsFalse(zoomOut);
			Assert.IsTrue(zoomReset);

			zoomReset = false;
			handled = sut.OnKeyEvent(default(IWebBrowser), default(IBrowser), KeyType.KeyUp, (int) Keys.NumPad0, default(int), CefEventFlags.ControlDown, false);

			Assert.IsFalse(handled);
			Assert.IsFalse(zoomIn);
			Assert.IsFalse(zoomOut);
			Assert.IsTrue(zoomReset);
		}

		[TestMethod]
		public void MustDetectPhantomShortcutsAndDeduplicateKeyDown()
		{
			var isShortcut = false;
			var modifiers = CefEventFlags.ControlDown | CefEventFlags.ShiftDown;

			Assert.IsFalse(PhantomStateManager.Instance.IsDarkReaderEnabled);
			Assert.IsFalse(PhantomStateManager.Instance.IsVimiumEnabled);

			// Ctrl+Shift+D: RawKeyDown toggles ON, subsequent KeyDown before KeyUp must not double-toggle
			Assert.IsTrue(sut.OnPreKeyEvent(default(IWebBrowser), default(IBrowser), KeyType.RawKeyDown, (int) Keys.D, 0, modifiers, false, ref isShortcut));
			Assert.IsTrue(isShortcut);
			Assert.IsTrue(PhantomStateManager.Instance.IsDarkReaderEnabled);

			Assert.IsTrue(sut.OnPreKeyEvent(default(IWebBrowser), default(IBrowser), KeyType.KeyDown, (int) Keys.D, 0, modifiers, false, ref isShortcut));
			Assert.IsTrue(PhantomStateManager.Instance.IsDarkReaderEnabled);

			Assert.IsTrue(sut.OnPreKeyEvent(default(IWebBrowser), default(IBrowser), KeyType.KeyUp, (int) Keys.D, 0, modifiers, false, ref isShortcut));
			Assert.IsTrue(PhantomStateManager.Instance.IsDarkReaderEnabled);

			// Ctrl+Shift+V: toggles Vimium ON
			isShortcut = false;
			Assert.IsTrue(sut.OnPreKeyEvent(default(IWebBrowser), default(IBrowser), KeyType.RawKeyDown, (int) Keys.V, 0, modifiers, false, ref isShortcut));
			Assert.IsTrue(isShortcut);
			Assert.IsTrue(PhantomStateManager.Instance.IsVimiumEnabled);
			Assert.IsTrue(sut.OnPreKeyEvent(default(IWebBrowser), default(IBrowser), KeyType.KeyUp, (int) Keys.V, 0, modifiers, false, ref isShortcut));

			// Ctrl+Shift+P: disables both, then restores both
			isShortcut = false;
			Assert.IsTrue(sut.OnPreKeyEvent(default(IWebBrowser), default(IBrowser), KeyType.RawKeyDown, (int) Keys.P, 0, modifiers, false, ref isShortcut));
			Assert.IsTrue(isShortcut);
			Assert.IsFalse(PhantomStateManager.Instance.IsDarkReaderEnabled);
			Assert.IsFalse(PhantomStateManager.Instance.IsVimiumEnabled);
			Assert.IsTrue(sut.OnPreKeyEvent(default(IWebBrowser), default(IBrowser), KeyType.KeyUp, (int) Keys.P, 0, modifiers, false, ref isShortcut));

			Assert.IsTrue(sut.OnPreKeyEvent(default(IWebBrowser), default(IBrowser), KeyType.RawKeyDown, (int) Keys.P, 0, modifiers, false, ref isShortcut));
			Assert.IsTrue(PhantomStateManager.Instance.IsDarkReaderEnabled);
			Assert.IsTrue(PhantomStateManager.Instance.IsVimiumEnabled);
		}
	}
}
