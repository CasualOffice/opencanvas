<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Listener;

use OCA\OpenCanvas\AppInfo\Application;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Files\Template\RegisterTemplateCreatorEvent;
use OCP\Files\Template\TemplateFileCreator;

/**
 * Registers "New canvas": an empty .ocanvas, which OpenCanvas opens on its own start screen
 * (blank, database, board, templates, import). Also listed by Talk's "New file" menu (S11a). The
 * Files front end moves it next to our two other entries, after a separator (S1a, src/files.js).
 *
 * @template-implements IEventListener<RegisterTemplateCreatorEvent>
 */
class RegisterTemplateCreator implements IEventListener {
	public function handle(Event $event): void {
		if (!$event instanceof RegisterTemplateCreatorEvent) {
			return;
		}
		$event->getTemplateManager()->registerTemplateFileCreator(static function () {
			$creator = new TemplateFileCreator(Application::APP_ID, 'New canvas', '.ocanvas');
			$creator->addMimetype(Application::MIME);
			$creator->setIconClass('icon-filetype-document'); // fallback for clients without inline icons
			$svg = @file_get_contents(__DIR__ . '/../../img/ocanvas.svg');
			if (is_string($svg) && $svg !== '') {
				$creator->setIconSvgInline($svg); // the .ocanvas icon (S2)
			}
			$creator->setActionLabel('Create');
			return $creator;
		});
	}
}
