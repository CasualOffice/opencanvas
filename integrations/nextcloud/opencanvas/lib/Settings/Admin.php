<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Settings;

use OCA\OpenCanvas\AppInfo\Application;
use OCA\OpenCanvas\Service\ConfigService;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Services\IInitialState;
use OCP\App\IAppManager;
use OCP\Settings\ISettings;
use OCP\Util;

/** Administration > OpenCanvas (S12): the Vue page in src/admin.js. */
class Admin implements ISettings {
	public function __construct(
		private ConfigService $config,
		private IInitialState $initialState,
		private IAppManager $appManager,
	) {
	}

	public function getForm(): TemplateResponse {
		$this->initialState->provideInitialState('admin', $this->config->forAdmin() + [
			'app_version' => $this->appManager->getAppVersion(Application::APP_ID),
		]);
		Util::addScript(Application::APP_ID, 'opencanvas-admin');
		return new TemplateResponse(Application::APP_ID, 'admin', []);
	}

	public function getSection(): string {
		return Application::APP_ID;
	}

	public function getPriority(): int {
		return 10;
	}
}
