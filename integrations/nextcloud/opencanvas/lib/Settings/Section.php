<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Settings;

use OCA\OpenCanvas\AppInfo\Application;
use OCP\IURLGenerator;
use OCP\Settings\IIconSection;

/** Administration > OpenCanvas (S12). */
class Section implements IIconSection {
	public function __construct(
		private IURLGenerator $url,
	) {
	}

	public function getID(): string {
		return Application::APP_ID;
	}

	public function getName(): string {
		return 'OpenCanvas';
	}

	public function getPriority(): int {
		return 75;
	}

	public function getIcon(): string {
		return $this->url->imagePath(Application::APP_ID, 'app-dark.svg');
	}
}
