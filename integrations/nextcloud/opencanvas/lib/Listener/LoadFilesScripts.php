<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Listener;

use OCA\OpenCanvas\AppInfo\Application;
use OCA\OpenCanvas\Service\ConfigService;
use OCP\AppFramework\Services\IInitialState;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Util;

/**
 * Files: "Open in full page" (S6b), the "New … canvas" entries (S1), the file icon (S2), the
 * sharing card and the optional "Can comment" share option (S8). Built from src/files.js.
 */
class LoadFilesScripts implements IEventListener {
	public function __construct(
		private ConfigService $config,
		private IInitialState $initialState,
	) {
	}

	public function handle(Event $event): void {
		$this->initialState->provideInitialState('files', [
			'commentRole' => $this->config->allowCommentRole(),
		]);
		Util::addScript(Application::APP_ID, 'opencanvas-files');
	}
}
