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
 * The Viewer handler (S4), built from src/viewer.js. Talk and public share pages load the Viewer
 * too, so a canvas shared into a conversation or opened from a link folder opens the same way.
 * Nextcloud 36 no longer dispatches LoadViewer (Viewer moved into server); see DESIGN.md §9.
 */
class LoadViewerScripts implements IEventListener {
	public function handle(Event $event): void {
		Util::addScript(Application::APP_ID, 'opencanvas-viewer');
	}
}
