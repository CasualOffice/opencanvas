<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Listener;

use OCA\OpenCanvas\AppInfo\Application;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Util;

/**
 * Loads the unstyled Viewer placeholder (js/opencanvas-viewer.js, built from src/viewer.js).
 * Talk loads the Viewer too, so a canvas shared into a conversation opens the same way.
 * Nextcloud 36 no longer dispatches LoadViewer (Viewer moved into server); see DESIGN.md §9.
 */
class LoadViewerScripts implements IEventListener {
	public function handle(Event $event): void {
		Util::addScript(Application::APP_ID, 'opencanvas-viewer');
	}
}
