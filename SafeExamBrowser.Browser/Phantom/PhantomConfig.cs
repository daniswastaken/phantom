/*
 * Copyright (c) 2026 ETH Zürich, IT Services
 * 
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

namespace SafeExamBrowser.Browser.Phantom
{
	/// <summary>
	/// Centralized configuration defaults for the Phantom built-in extensions.
	/// </summary>
	public static class PhantomConfig
	{
		public const bool DefaultDarkReaderEnabled = false;
		public const bool DefaultVimiumEnabled = false;

		public const int DarkReaderBrightness = 100;
		public const int DarkReaderContrast = 95;
		public const int DarkReaderSepia = 5;

		public const int ToastDurationMs = 1200;
	}
}
