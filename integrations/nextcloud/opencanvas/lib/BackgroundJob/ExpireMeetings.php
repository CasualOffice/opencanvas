<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\BackgroundJob;

use OCA\OpenCanvas\Talk\MeetingService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\IJob;
use OCP\BackgroundJob\TimedJob;

/**
 * TALK-01 3c: a meeting canvas nobody saved or discarded within 10 minutes of the call ending is
 * discarded. The panel also settles it on the next look; this catches meetings nobody looks at.
 */
class ExpireMeetings extends TimedJob {
	public function __construct(
		ITimeFactory $time,
		private MeetingService $meetings,
	) {
		parent::__construct($time);
		$this->setInterval(300);
		$this->setTimeSensitivity(IJob::TIME_SENSITIVE);
	}

	protected function run($argument): void {
		$this->meetings->expire();
	}
}
