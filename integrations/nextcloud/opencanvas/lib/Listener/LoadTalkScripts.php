<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Listener;

use OCA\OpenCanvas\AppInfo\Application;
use OCP\AppFramework\Http\Events\BeforeTemplateRenderedEvent;
use OCP\Collaboration\Reference\RenderReferenceEvent;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Util;

/**
 * TALK-01: on Talk's pages (signed in and public conversations) the Canvas panel
 * (src/talk.js); wherever link previews render, the canvas card widget (src/reference.js).
 *
 * @template-implements IEventListener<Event>
 */
class LoadTalkScripts implements IEventListener {
	public function handle(Event $event): void {
		if ($event instanceof RenderReferenceEvent) {
			Util::addScript(Application::APP_ID, 'opencanvas-reference');
			return;
		}
		if ($event instanceof BeforeTemplateRenderedEvent && $event->getResponse()->getApp() === 'spreed') {
			Util::addScript(Application::APP_ID, 'opencanvas-reference');
			Util::addScript(Application::APP_ID, 'opencanvas-talk');
		}
	}
}
