/*
 * Copyright (c) 2026 ETH Zürich, IT Services
 * 
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

using System;
using System.Threading;
using System.Threading.Tasks;
using SafeExamBrowser.Logging.Contracts;
using SafeExamBrowser.Monitoring.Contracts;
using SafeExamBrowser.Monitoring.Contracts.Events;
using SafeExamBrowser.WindowsApi.Contracts;

namespace SafeExamBrowser.Monitoring.Suspension
{
	public class SuspensionMonitor : ISuspensionMonitor
	{
		private readonly ILogger logger;
		private bool active;

#pragma warning disable 0067
		public event SuspensionDetectedEventHandler SuspensionDetected;
#pragma warning restore 0067

		public SuspensionMonitor(ILogger logger, INativeMethods nativeMethods)
		{
			this.logger = logger;
		}

		public void Start()
		{
			active = true;
			logger.Info("Suspension monitoring is disabled.");
		}

		public void Stop()
		{
			if (active)
			{
				active = false;
				logger.Info("Stopped monitoring.");
			}
		}
	}
}
