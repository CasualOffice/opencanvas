<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Controller;

use OCA\OpenCanvas\AppInfo\Application;
use OCA\OpenCanvas\Service\ConfigService;
use OCA\OpenCanvas\Service\DiscoveryService;
use OCA\OpenCanvas\Service\TokenService;
use OCA\OpenCanvas\Wopi\LaunchGuard;
use OCA\OpenCanvas\Wopi\PublicShareAuth;
use OCA\OpenCanvas\Wopi\Role;
use OCA\OpenCanvas\Wopi\StarterFiles;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Services\IInitialState;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\Node;
use OCP\IGroupManager;
use OCP\IRequest;
use OCP\ISession;
use OCP\IUserManager;
use OCP\IUserSession;
use OCP\Security\ISecureRandom;
use OCP\Share\IManager as IShareManager;
use OCP\Share\IShare;
use OCP\Util;

/**
 * Opening a canvas: mints a WOPI access token for the person and hands the browser what it needs
 * to form-POST it into the OpenCanvas iframe (docs/05 §6 "Launch"). Errors use the shared codes
 * of UI-SCREENS S13 (LaunchGuard). Also creates new canvases (S1) and serves the full page (S5).
 */
class LaunchController extends Controller {
	public function __construct(
		string $appName,
		IRequest $request,
		private ConfigService $config,
		private TokenService $tokens,
		private DiscoveryService $discovery,
		private IUserSession $userSession,
		private IUserManager $userManager,
		private IGroupManager $groupManager,
		private IRootFolder $rootFolder,
		private IShareManager $shareManager,
		private ISession $session,
		private ISecureRandom $random,
		private IInitialState $initialState,
	) {
		parent::__construct($appName, $request);
	}

	/** JSON launch data for a signed-in user (Viewer handler, full page, Talk). */
	#[NoAdminRequired]
	public function token(int $fileId): JSONResponse {
		$uid = $this->userSession->getUser()?->getUID();
		$file = $uid === null ? null : $this->userFile($uid, $fileId);
		$code = LaunchGuard::decide(
			$this->config->publicUrl() !== '',
			$file !== null,
			$file !== null && $file->isReadable(),
			$file?->getSize() ?? 0,
		);
		if ($code !== null) {
			return $this->error($code, $file);
		}
		$m = $this->tokens->mint($fileId, $uid, null, null, null, Role::EDIT);
		return new JSONResponse($this->launchData($fileId, $m) + ['name' => $file->getName()]);
	}

	/**
	 * What the public page needs before launching (S7): which file, whether it is an edit link
	 * (then the guest gives a name first), and whether canvases may open from links at all.
	 */
	#[PublicPage]
	#[NoCSRFRequired]
	public function publicInfo(string $shareToken): JSONResponse {
		$share = $this->linkShare($shareToken);
		if ($share === null) {
			return new JSONResponse(['error' => 'NOT_FOUND'], Http::STATUS_NOT_FOUND);
		}
		$node = $share->getNode();
		$owner = $this->userManager->getDisplayName($share->getShareOwner()) ?? $share->getShareOwner();
		if (!$this->config->allowPublicLinks()) {
			return new JSONResponse(['error' => 'LINKS_DISABLED', 'owner' => $owner], Http::STATUS_NOT_FOUND);
		}
		return new JSONResponse([
			'fileId' => $node->getId(),
			'name' => $node->getName(),
			'size' => $node->getSize(),
			'permissions' => $share->getPermissions(),
			'hideDownload' => $share->getHideDownload(),
			'owner' => $owner,
			'configured' => $this->config->publicUrl() !== '',
		]);
	}

	/** JSON launch data for a guest on a public link share (password checked by Nextcloud). */
	#[PublicPage]
	public function publicToken(string $shareToken, int $fileId, string $guestName = ''): JSONResponse {
		$share = $this->linkShare($shareToken);
		if ($share === null) {
			return new JSONResponse(['error' => 'NOT_FOUND'], Http::STATUS_NOT_FOUND);
		}
		if (!$this->config->allowPublicLinks()) {
			return new JSONResponse(['error' => 'LINKS_DISABLED'], Http::STATUS_NOT_FOUND);
		}
		// A password-protected link must have been unlocked in this browser session first, on
		// Nextcloud's own password page (S7a).
		if (!PublicShareAuth::isUnlocked($this->session->get(PublicShareAuth::SESSION_KEY), $shareToken, $share->getPassword())) {
			return new JSONResponse(['error' => 'PASSWORD_REQUIRED'], Http::STATUS_FORBIDDEN);
		}
		$node = $share->getNode();
		$file = $node instanceof Folder ? $node->getFirstNodeById($fileId) : $node;
		$found = $file instanceof File && $file->getId() === $fileId;
		$code = LaunchGuard::decide($this->config->publicUrl() !== '', $found, $found, $found ? $file->getSize() : 0);
		if ($code !== null) {
			return $this->error($code, $found ? $file : null);
		}
		$guestId = $this->session->get('opencanvas_guest_id');
		if (!is_string($guestId) || $guestId === '') {
			$guestId = $this->random->generate(16, ISecureRandom::CHAR_ALPHANUMERIC);
			$this->session->set('opencanvas_guest_id', $guestId);
		}
		$name = mb_substr(trim($guestName), 0, 64);
		$m = $this->tokens->mint($fileId, null, $shareToken, $guestId, $name === '' ? null : $name, Role::EDIT);
		return new JSONResponse($this->launchData($fileId, $m) + ['name' => $file->getName()]);
	}

	/**
	 * Why did the canvas not load? Called by the page when OpenCanvas reported an error before the
	 * canvas was up, or never answered (S13): not set up, a recent proof failure, or unreachable.
	 */
	#[NoAdminRequired]
	#[PublicPage]
	public function diagnose(): JSONResponse {
		if ($this->config->publicUrl() === '') {
			return new JSONResponse(['error' => 'NOT_CONFIGURED']);
		}
		if ($this->discovery->recentProofFailure()) {
			return new JSONResponse(['error' => 'PROOF_REJECTED']);
		}
		return new JSONResponse(['error' => 'UNREACHABLE', 'discovery' => $this->discovery->xml(true) !== null]);
	}

	/** Full page (S5): Nextcloud's header, a slim bar with the way back to Files, the canvas. */
	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function open(int $fileId): TemplateResponse {
		$user = $this->userSession->getUser();
		$file = $user === null ? null : $this->userFile($user->getUID(), $fileId);
		$state = ['fileId' => $fileId, 'isAdmin' => $user !== null && $this->groupManager->isAdmin($user->getUID())];
		if ($file !== null) {
			$userFolder = $this->rootFolder->getUserFolder($user->getUID());
			$dir = dirname((string)$userFolder->getRelativePath($file->getPath()));
			$state += [
				'name' => $file->getName(),
				'dir' => $dir === '.' ? '/' : $dir,
				'canDownload' => $this->canDownload($file),
				'davPath' => $userFolder->getRelativePath($file->getPath()),
				'user' => $user->getUID(),
			];
		}
		$this->initialState->provideInitialState('page', $state);
		Util::addScript(Application::APP_ID, 'opencanvas-fullpage');
		$res = new TemplateResponse($this->appName, 'editor', []);
		$res->setContentSecurityPolicy($this->config->frameCsp());
		return $res;
	}

	/**
	 * Creates `{dir}/{name}.ocanvas` (blank, database or whiteboard) in the user's files and
	 * answers its file id. Used by the Files "New … canvas" entries (S1).
	 */
	#[NoAdminRequired]
	public function create(string $dir, string $name, string $kind = 'blank'): JSONResponse {
		$uid = $this->userSession->getUser()?->getUID();
		if ($uid === null || !in_array($kind, StarterFiles::KINDS, true)) {
			return new JSONResponse(['error' => 'BAD_REQUEST'], Http::STATUS_BAD_REQUEST);
		}
		$name = trim(str_replace(['/', '\\', "\0"], '', $name));
		if ($name === '' || $name === '.' || $name === '..') {
			return new JSONResponse(['error' => 'BAD_NAME'], Http::STATUS_BAD_REQUEST);
		}
		if (!str_ends_with(strtolower($name), '.ocanvas')) {
			$name .= '.ocanvas';
		}
		try {
			$folder = $this->rootFolder->getUserFolder($uid)->get($dir === '' ? '/' : $dir);
			if (!$folder instanceof Folder || !$folder->isCreatable()) {
				return new JSONResponse(['error' => 'FORBIDDEN', 'owner' => $this->ownerName($folder)], Http::STATUS_FORBIDDEN);
			}
			$title = pathinfo($name, PATHINFO_FILENAME);
			$file = $folder->newFile($folder->getNonExistingName($name), StarterFiles::bytes($kind, $title));
		} catch (\OCP\Files\NotFoundException) {
			return new JSONResponse(['error' => 'NOT_FOUND'], Http::STATUS_NOT_FOUND);
		} catch (\OCP\Files\NotPermittedException) {
			return new JSONResponse(['error' => 'FORBIDDEN', 'owner' => $this->ownerName($folder ?? null)], Http::STATUS_FORBIDDEN);
		}
		return new JSONResponse(['fileId' => $file->getId(), 'name' => $file->getName()], Http::STATUS_CREATED);
	}

	private function userFile(string $uid, int $fileId): ?File {
		$node = $this->rootFolder->getUserFolder($uid)->getFirstNodeById($fileId);
		return $node instanceof File ? $node : null;
	}

	private function linkShare(string $token): ?IShare {
		try {
			$share = $this->shareManager->getShareByToken($token);
		} catch (\Throwable) {
			return null;
		}
		return in_array($share->getShareType(), [IShare::TYPE_LINK, IShare::TYPE_EMAIL], true) ? $share : null;
	}

	private function error(string $code, ?File $file): JSONResponse {
		$body = ['error' => $code];
		if ($code === 'TOO_LARGE' && $file !== null) {
			$body['size'] = $file->getSize();
		}
		return new JSONResponse($body, LaunchGuard::status($code));
	}

	/** "Allow download and sync" on the share the file comes through (S4d). */
	private function canDownload(File $file): bool {
		try {
			$storage = $file->getStorage();
			if ($storage->instanceOfStorage(\OCP\Files\Storage\ISharedStorage::class) && method_exists($storage, 'getShare')) {
				return $storage->getShare()->getAttributes()?->getAttribute('permissions', 'download') !== false;
			}
		} catch (\Throwable) {
		}
		return true;
	}

	private function ownerName(?Node $node): string {
		$owner = $node?->getOwner();
		return $owner === null ? '' : $owner->getDisplayName();
	}

	/** @param array{token: string, ttlMs: int} $m */
	private function launchData(int $fileId, array $m): array {
		return [
			// Form-POST access_token and access_token_ttl to this URL, target = the iframe.
			'action' => $this->config->publicUrl() . '/v1/launch?WOPISrc=' . rawurlencode($this->config->wopiSrc($fileId)),
			'access_token' => $m['token'],
			'access_token_ttl' => $m['ttlMs'],
			'origin' => $this->config->publicOrigin(),
		];
	}
}
