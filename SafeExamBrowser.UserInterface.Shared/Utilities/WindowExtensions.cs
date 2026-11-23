/*
 * Copyright (c) 2026 ETH Zürich, IT Services
 * 
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace SafeExamBrowser.UserInterface.Shared.Utilities
{
	public static class WindowExtensions
	{
		private const int DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1 = 19;
		private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
		private const int GWL_STYLE = -16;
		private const uint MF_BYCOMMAND = 0x0;
		private const uint MF_ENABLED = 0x0;
		private const uint MF_GRAYED = 0x1;
		private const uint SC_CLOSE = 0xF060;
		private const uint SWP_SHOWWINDOW = 0x40;
		private const uint WDA_EXCLUDEFROMCAPTURE = 0x11;
		private const int WS_SYSMENU = 0x80000;

		private static readonly IntPtr HWND_BOTTOM = new IntPtr(1);

		public static void DisableCloseButton(this Window window)
		{
			var helper = new WindowInteropHelper(window);
			var systemMenu = GetSystemMenu(helper.Handle, false);

			if (systemMenu != IntPtr.Zero)
			{
				EnableMenuItem(systemMenu, SC_CLOSE, MF_BYCOMMAND | MF_GRAYED);
			}
		}

		public static void EnableCloseButton(this Window window)
		{
			var helper = new WindowInteropHelper(window);
			var systemMenu = GetSystemMenu(helper.Handle, false);

			if (systemMenu != IntPtr.Zero)
			{
				EnableMenuItem(systemMenu, SC_CLOSE, MF_BYCOMMAND | MF_ENABLED);
			}
		}

		public static void EnableImmersiveDarkMode(this Window window)
		{
			if (window == null)
			{
				return;
			}

			void applyDarkMode(IntPtr hwnd)
			{
				if (hwnd == IntPtr.Zero)
				{
					return;
				}

				try
				{
					var useDark = 1;
					if (DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref useDark, sizeof(int)) != 0)
					{
						DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1, ref useDark, sizeof(int));
					}
				}
				catch
				{
				}
			}

			var helper = new WindowInteropHelper(window);

			if (helper.Handle != IntPtr.Zero)
			{
				applyDarkMode(helper.Handle);
			}
			else
			{
				EventHandler handler = null;
				handler = (sender, args) =>
				{
					window.SourceInitialized -= handler;
					applyDarkMode(new WindowInteropHelper(window).Handle);
				};
				window.SourceInitialized += handler;
			}
		}

		public static bool ExcludeFromCapture(this Window window)
		{
			var helper = new WindowInteropHelper(window);

			return SetWindowDisplayAffinity(helper.Handle, WDA_EXCLUDEFROMCAPTURE);
		}

		public static void ExecuteWithAccess(this Window window, Action action)
		{
			if (window.CheckAccess())
			{
				action();
			}
			else
			{
				window.Dispatcher.Invoke(action);
			}
		}

		public static void HideCloseButton(this Window window)
		{
			var helper = new WindowInteropHelper(window);
			var style = GetWindowLong(helper.Handle, GWL_STYLE) & ~WS_SYSMENU;

			SetWindowLong(helper.Handle, GWL_STYLE, style);
		}

		public static void MoveToBackground(this Window window)
		{
			var helper = new WindowInteropHelper(window);
			var x = (int) window.TransformFromPhysical(window.Left, 0).X;
			var y = (int) window.TransformFromPhysical(0, window.Top).Y;
			var width = (int) window.TransformFromPhysical(window.Width, 0).X;
			var height = (int) window.TransformFromPhysical(0, window.Height).Y;

			SetWindowPos(helper.Handle, HWND_BOTTOM, x, y, width, height, SWP_SHOWWINDOW);
		}

		[DllImport("dwmapi.dll")]
		private static extern int DwmSetWindowAttribute(IntPtr hwnd, int dwAttribute, ref int pvAttribute, int cbAttribute);

		[DllImport("user32.dll")]
		private static extern bool EnableMenuItem(IntPtr hMenu, uint uIDEnableItem, uint uEnable);

		[DllImport("user32.dll")]
		private static extern IntPtr GetSystemMenu(IntPtr hWnd, bool bRevert);

		[DllImport("user32.dll")]
		private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

		[DllImport("user32.dll")]
		public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint dwAffinity);

		[DllImport("user32.dll")]
		private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

		[DllImport("user32.dll")]
		private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
	}
}
