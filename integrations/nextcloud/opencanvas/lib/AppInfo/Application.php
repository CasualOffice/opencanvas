<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\AppInfo;

use OCA\OpenCanvas\Listener\LoadFilesScripts;
use OCA\OpenCanvas\Listener\LoadViewerScripts;
use OCA\OpenCanvas\Listener\RegisterTemplateCreator;
use OCA\OpenCanvas\Listener\ShareChangedListener;
use OCA\OpenCanvas\Service\RoleSyncService;
use OCP\Share\Events\ShareDeletedEvent;
use OCP\Util;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\Files\Template\RegisterTemplateCreatorEvent;

class Application extends App implements IBootstrap {
	public const APP_ID = 'opencanvas';
	public const MIME = 'application/vnd.opencanvas+zip';

	public function __construct(array $urlParams = []) {
		parent::__construct(self::APP_ID, $urlParams);
	}

	public function register(IRegistrationContext $context): void {
		// "New canvas" in the Files + menu (server side, like Nextcloud Office and Whiteboard).
		$context->registerEventListener(RegisterTemplateCreatorEvent::class, RegisterTemplateCreator::class);
		// Placeholder scripts: Files action and New menu entries, Viewer handler (UI-SCREENS.md).
		// Class names as strings: the Files and Viewer apps may be disabled.
		$context->registerEventListener('OCA\Files\Event\LoadAdditionalScriptsEvent', LoadFilesScripts::class);
		$context->registerEventListener('OCA\Viewer\Event\LoadViewer', LoadViewerScripts::class);
		// Share revoked or changed: switch open canvases at once (docs/05 §7 role API).
		$context->registerEventListener(ShareDeletedEvent::class, ShareChangedListener::class);
		// Tokens and the token secret are sensitive: kept out of logged stack traces.
		$context->registerSensitiveMethods(\OCA\OpenCanvas\Wopi\TokenCodec::class, ['__construct', 'encode', 'decode']);
	}

	public function boot(IBootContext $context): void {
		// Nextcloud 30-32 have no typed "share updated" event; permission changes come through
		// the legacy hook emitted by Share20\Manager::updateShare.
		Util::connectHook('OCP\Share', 'post_update_permissions', self::class, 'onPermissionsUpdated');
	}

	public static function onPermissionsUpdated(array $params): void {
		\OCP\Server::get(RoleSyncService::class)->permissionsUpdated($params);
	}
}
