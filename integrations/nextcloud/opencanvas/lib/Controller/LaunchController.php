<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Controller;

use OCA\OpenCanvas\Service\ConfigService;
use OCA\OpenCanvas\Service\FileAccessService;
use OCA\OpenCanvas\Service\TokenService;
use OCA\OpenCanvas\Wopi\Role;
use OCA\OpenCanvas\Wopi\StarterFiles;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\IRequest;
use OCP\ISession;
use OCP\IUserSession;
use OCP\Security\ISecureRandom;
use OCP\Share\IManager as IShareManager;

/**
 * Opening a canvas: mints a WOPI access token for the person and hands the browser what it needs
 * to form-POST it into the OpenCanvas iframe (docs/05 §6 "Launch"). Also creates new canvases.
 * The pages are unstyled placeholders until the prototypes are approved (UI-SCREENS.md).
 */
class LaunchController extends Controller {
	public function __construct(
		string $appName,
		IRequest $request,
		private ConfigService $config,
		private TokenService $tokens,
		private FileAccessService $access,
		private IUserSession $userSession,
		private IRootFolder $rootFolder,
		private IShareManager $shareManager,
		private ISession $session,
		private ISecureRandom $random,
	) {
		parent::__construct($appName, $request);
	}

	/** JSON launch data for a signed-in user (Viewer handler, Files action, Talk). */
	#[NoAdminRequired]
	public function token(int $fileId): JSONResponse {
		$uid = $this->userSession->getUser()?->getUID();
		if ($uid === null || $this->access->maxRoleFor($uid, $fileId) === null) {
			return new JSONResponse(['error' => 'NOT_FOUND'], Http::STATUS_NOT_FOUND);
		}
		if ($this->config->publicUrl() === '') {
			return new JSONResponse(['error' => 'NOT_CONFIGURED'], Http::STATUS_SERVICE_UNAVAILABLE);
		}
		$m = $this->tokens->mint($fileId, $uid, null, null, null, Role::EDIT);
		return new JSONResponse($this->launchData($fileId, $m));
	}

	/** JSON launch data for a guest on a public link share (password checked by Nextcloud). */
	#[PublicPage]
	public function publicToken(string $shareToken, int $fileId, string $guestName = ''): JSONResponse {
		if (!$this->config->allowPublicLinks() || $this->config->publicUrl() === '') {
			return new JSONResponse(['error' => 'NOT_AVAILABLE'], Http::STATUS_NOT_FOUND);
		}
		try {
			$share = $this->shareManager->getShareByToken($shareToken);
		} catch (\Throwable) {
			return new JSONResponse(['error' => 'NOT_FOUND'], Http::STATUS_NOT_FOUND);
		}
		// A password-protected link must have been unlocked in this browser session first
		// (Nextcloud's public share controller records it). To verify on a live instance.
		if ($share->getPassword() !== null && $this->session->get('public_link_authenticated_token') !== $shareToken) {
			return new JSONResponse(['error' => 'PASSWORD_REQUIRED'], Http::STATUS_FORBIDDEN);
		}
		$guestId = $this->session->get('opencanvas_guest_id');
		if (!is_string($guestId) || $guestId === '') {
			$guestId = $this->random->generate(16, ISecureRandom::CHAR_ALPHANUMERIC);
			$this->session->set('opencanvas_guest_id', $guestId);
		}
		$name = mb_substr(trim($guestName), 0, 64);
		$m = $this->tokens->mint($fileId, null, $shareToken, $guestId, $name === '' ? null : $name, Role::EDIT);
		$claims = $this->tokens->check($m['token'], $fileId);
		if ($claims === null || $this->access->resolve($claims) === null) {
			return new JSONResponse(['error' => 'NOT_FOUND'], Http::STATUS_NOT_FOUND);
		}
		return new JSONResponse($this->launchData($fileId, $m));
	}

	/** Full-page editor (placeholder): an iframe and the launch form, nothing styled. */
	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function open(int $fileId): TemplateResponse {
		$data = $this->token($fileId)->getData();
		$res = new TemplateResponse($this->appName, 'editor', ['launch' => $data]);
		$csp = new ContentSecurityPolicy();
		if ($this->config->publicUrl() !== '') {
			$csp->addAllowedFrameDomain($this->config->publicUrl());
			$csp->addAllowedFormActionDomain($this->config->publicUrl());
		}
		$res->setContentSecurityPolicy($csp);
		return $res;
	}

	/**
	 * Creates `{dir}/{name}.ocanvas` (blank, database or whiteboard) in the user's files and
	 * answers its file id. Used by the Files "New" menu entries.
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
				return new JSONResponse(['error' => 'FORBIDDEN'], Http::STATUS_FORBIDDEN);
			}
			$title = pathinfo($name, PATHINFO_FILENAME);
			$file = $folder->newFile($folder->getNonExistingName($name), StarterFiles::bytes($kind, $title));
		} catch (\OCP\Files\NotFoundException) {
			return new JSONResponse(['error' => 'NOT_FOUND'], Http::STATUS_NOT_FOUND);
		} catch (\OCP\Files\NotPermittedException) {
			return new JSONResponse(['error' => 'FORBIDDEN'], Http::STATUS_FORBIDDEN);
		}
		return new JSONResponse(['fileId' => $file->getId(), 'name' => $file->getName()], Http::STATUS_CREATED);
	}

	/** @param array{token: string, ttlMs: int} $m */
	private function launchData(int $fileId, array $m): array {
		return [
			// Form-POST access_token and access_token_ttl to this URL, target = the iframe.
			'action' => $this->config->publicUrl() . '/v1/launch?WOPISrc=' . rawurlencode($this->config->wopiSrc($fileId)),
			'access_token' => $m['token'],
			'access_token_ttl' => $m['ttlMs'],
		];
	}
}
