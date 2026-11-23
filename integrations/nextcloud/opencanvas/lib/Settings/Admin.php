<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Settings;

use OCA\OpenCanvas\AppInfo\Application;
use OCA\OpenCanvas\Service\ConfigService;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\Settings\ISettings;

/** Admin settings page (unstyled placeholder form; UI-SCREENS.md "Admin settings"). */
class Admin implements ISettings {
	public function __construct(
		private ConfigService $config,
	) {
	}

	public function getForm(): TemplateResponse {
		return new TemplateResponse(Application::APP_ID, 'admin', ['settings' => $this->config->forAdmin()]);
	}

	public function getSection(): string {
		return 'server'; // the "Basic settings" section; our own section waits for the UI
	}

	public function getPriority(): int {
		return 60;
	}
}
