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
 * Public link page of a single .ocanvas file (S7): the canvas fills the page under Nextcloud's
 * public header, after the guest name prompt on edit links. Built from src/public.js. Folder links
 * open canvases through the Viewer handler instead.
 */
class LoadPublicScripts implements IEventListener {
	public function handle(Event $event): void {
		if (!method_exists($event, 'getShare')) {
			return;
		}
		try {
			$node = $event->getShare()->getNode();
		} catch (\Throwable) {
			return;
		}
		if ($node->getMimetype() === Application::MIME) {
			Util::addScript(Application::APP_ID, 'opencanvas-public');
		}
	}
}
