<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Listener;

use OCA\OpenCanvas\AppInfo\Application;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Util;

/** Loads the unstyled Files placeholder (js/opencanvas-files.js, built from src/files.js). */
class LoadFilesScripts implements IEventListener {
	public function handle(Event $event): void {
		Util::addScript(Application::APP_ID, 'opencanvas-files');
	}
}
