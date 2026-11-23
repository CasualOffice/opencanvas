<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Listener;

use OCA\OpenCanvas\Service\ConfigService;
use OCP\AppFramework\Http\EmptyContentSecurityPolicy;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Security\CSP\AddContentSecurityPolicyEvent;

/**
 * Pages that open a canvas (Files, Viewer, Talk, public links) frame OpenCanvas and form-POST the
 * launch into that frame: allow its origin as frame-src and form-action, like Nextcloud Office.
 *
 * @template-implements IEventListener<AddContentSecurityPolicyEvent>
 */
class AddCsp implements IEventListener {
	public function __construct(
		private ConfigService $config,
	) {
	}

	public function handle(Event $event): void {
		if ($event instanceof AddContentSecurityPolicyEvent && $this->config->publicOrigin() !== '') {
			$csp = new EmptyContentSecurityPolicy();
			$csp->addAllowedFrameDomain($this->config->publicOrigin());
			$csp->addAllowedFormActionDomain($this->config->publicOrigin());
			$event->addPolicy($csp);
		}
	}
}
