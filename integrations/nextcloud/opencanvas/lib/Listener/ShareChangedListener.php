<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Listener;

use OCA\OpenCanvas\Service\RoleSyncService;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Share\Events\ShareDeletedEvent;

/**
 * Share deleted: tell OpenCanvas the person's new live role, so an open canvas follows at once
 * (closed when they lost access, read-only when only a read share is left).
 *
 * @template-implements IEventListener<ShareDeletedEvent>
 */
class ShareChangedListener implements IEventListener {
	public function __construct(
		private RoleSyncService $roles,
	) {
	}

	public function handle(Event $event): void {
		if ($event instanceof ShareDeletedEvent) {
			$this->roles->shareChanged($event->getShare());
		}
	}
}
