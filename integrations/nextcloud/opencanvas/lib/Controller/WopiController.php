<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Controller;

use OCA\OpenCanvas\Service\ConfigService;
use OCA\OpenCanvas\Service\DiscoveryService;
use OCA\OpenCanvas\Service\FileAccessService;
use OCA\OpenCanvas\Service\TokenService;
use OCA\OpenCanvas\Wopi\AccessClaims;
use OCA\OpenCanvas\Wopi\ProofVerifier;
use OCA\OpenCanvas\Wopi\VersionList;
use OCA\OpenCanvas\Wopi\WopiUtil;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\DataDownloadResponse;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\Files\File;
use OCP\Files\Lock\LockedException as FilesLockedException;
use OCP\IRequest;
use OCP\IUserManager;
use OCP\IUserSession;
use OCP\Lock\LockedException;
use Psr\Log\LoggerInterface;

/**
 * The WOPI host OpenCanvas calls (docs/05 §6): CheckFileInfo, GetFile, PutFile, PUT_RELATIVE.
 * Every call must carry a valid proof (the request was made by the OpenCanvas server, which
 * enforces roles on every edit), a valid access token for this file id, and the person must still
 * have access in Nextcloud. Tokens are never logged.
 */
class WopiController extends Controller {
	private const MAX_BODY = 100 * 1024 * 1024; // OpenCanvas's .ocanvas read limit

	public function __construct(
		string $appName,
		IRequest $request,
		private ConfigService $config,
		private TokenService $tokens,
		private FileAccessService $access,
		private DiscoveryService $discovery,
		private IUserManager $userManager,
		private IUserSession $userSession,
		private ITimeFactory $time,
		private LoggerInterface $logger,
	) {
		parent::__construct($appName, $request);
	}

	#[PublicPage]
	#[NoCSRFRequired]
	public function checkFileInfo(int $fileId, string $access_token = ''): Response {
		[$claims, $err] = $this->authorize($fileId, $access_token, false);
		if ($claims === null) {
			return $err;
		}
		$r = $this->access->resolve($claims);
		if ($r === null) {
			return new JSONResponse([], Http::STATUS_NOT_FOUND);
		}
		/** @var File $file */
		$file = $r['file'];
		$flags = $r['flags'];
		unset($flags['role']);
		$info = [
			'BaseFileName' => $file->getName(),
			'Size' => $file->getSize(),
			'Version' => (string)$file->getEtag(),
			'LastModifiedTime' => WopiUtil::isoTime($file->getMTime()),
			'OwnerId' => (string)$file->getOwner()?->getUID(),
			'UserId' => $r['userId'],
			'UserFriendlyName' => $r['name'],
			'UserExtraInfo' => array_filter(['avatar' => $r['avatar']]),
			'PostMessageOrigin' => $this->origin(),
			'SupportsLocks' => false,
			'SupportsUpdate' => true,
			// VH-01c: the version extensions below, over files_versions (docs/30 §3.2).
			'OpenCanvas_SupportsVersions' => $this->versionManager() !== null,
		] + $flags;
		return new JSONResponse($info);
	}

	#[PublicPage]
	#[NoCSRFRequired]
	public function getFile(int $fileId, string $access_token = ''): Response {
		[$claims, $err] = $this->authorize($fileId, $access_token, true);
		if ($claims === null) {
			return $err;
		}
		$r = $this->access->resolve($claims);
		if ($r === null) {
			return new JSONResponse([], Http::STATUS_NOT_FOUND);
		}
		$file = $r['file'];
		if ($file->getSize() > self::MAX_BODY) {
			return new JSONResponse([], Http::STATUS_REQUEST_ENTITY_TOO_LARGE);
		}
		return new DataDownloadResponse($file->getContent(), $file->getName(), 'application/octet-stream');
	}

	#[PublicPage]
	#[NoCSRFRequired]
	public function putFile(int $fileId, string $access_token = ''): Response {
		[$claims, $err] = $this->authorize($fileId, $access_token, true);
		if ($claims === null) {
			return $err;
		}
		$override = $this->request->getHeader('X-WOPI-Override');
		if ($override !== '' && $override !== 'PUT') {
			return new JSONResponse([], Http::STATUS_NOT_IMPLEMENTED);
		}
		$r = $this->access->resolve($claims);
		if ($r === null) {
			return new JSONResponse([], Http::STATUS_NOT_FOUND);
		}
		if ($r['flags']['UserCanWrite'] !== true) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED); // OpenCanvas tries the next editor's token
		}
		$file = $r['file'];
		$sent = $this->request->getHeader('X-COOL-WOPI-Timestamp');
		if ($sent !== '' && $sent !== WopiUtil::isoTime($file->getMTime())) {
			return new JSONResponse(['COOLStatusCode' => 1010], Http::STATUS_CONFLICT);
		}
		$body = $this->body();
		if ($body === null) {
			return new JSONResponse([], Http::STATUS_REQUEST_ENTITY_TOO_LARGE);
		}
		try {
			$this->asEditor($claims, fn () => $file->putContent($body));
		} catch (LockedException|FilesLockedException) {
			return new JSONResponse([], Http::STATUS_LOCKED);
		}
		// A named or restore save labels the version it just made (closes G3).
		$labels = VersionList::labelsFor(
			$this->request->getHeader('X-COOL-WOPI-IsAutosave'),
			$this->request->getHeader('X-OpenCanvas-Commit-Message'),
			$this->request->getHeader('X-OpenCanvas-Restored-From'),
		);
		if ($labels !== []) {
			$this->labelVersion($file, $labels);
		}
		$this->logger->info('OpenCanvas saved file {fileId}', ['app' => 'opencanvas', 'fileId' => $fileId]);
		return new JSONResponse(['LastModifiedTime' => WopiUtil::isoTime($file->getMTime())]);
	}

	/** Extension `GET {WOPISrc}/versions` (VH-01c, docs/30 §3.2): the file's Nextcloud versions. */
	#[PublicPage]
	#[NoCSRFRequired]
	public function versions(int $fileId, string $access_token = ''): Response {
		[$claims, $err] = $this->authorize($fileId, $access_token, '/versions');
		if ($claims === null) {
			return $err;
		}
		[$file, $user, $manager] = $this->versionContext($claims);
		if ($file === null) {
			return new JSONResponse([], Http::STATUS_NOT_FOUND);
		}
		$rows = [];
		foreach ($manager->getVersionsForFile($user, $file) as $v) {
			$rows[] = [
				'revision' => $v->getRevisionId(),
				'timestamp' => (int)$v->getTimestamp(),
				'size' => (int)$v->getSize(),
				'metadata' => method_exists($v, 'getMetadata') ? $v->getMetadata() : [],
			];
		}
		return new JSONResponse(VersionList::map($rows));
	}

	/** Extension `GET {WOPISrc}/versions/{version}/contents`: one version's bytes (410 when gone). */
	#[PublicPage]
	#[NoCSRFRequired]
	public function versionContents(int $fileId, string $version, string $access_token = ''): Response {
		[$claims, $err] = $this->authorize($fileId, $access_token, '/versions/' . $version . '/contents');
		if ($claims === null) {
			return $err;
		}
		[$file, $user, $manager] = $this->versionContext($claims);
		if ($file === null) {
			return new JSONResponse([], Http::STATUS_NOT_FOUND);
		}
		foreach ($manager->getVersionsForFile($user, $file) as $v) {
			if ((string)$v->getRevisionId() !== $version) {
				continue;
			}
			if ((int)$v->getSize() > self::MAX_BODY) {
				return new JSONResponse([], Http::STATUS_REQUEST_ENTITY_TOO_LARGE);
			}
			// The current version is the file itself.
			$stream = (string)$v->getRevisionId() === (string)$file->getMTime()
				? $file->fopen('rb')
				: $v->getBackend()->read($v);
			if ($stream === false) {
				break;
			}
			$bytes = stream_get_contents($stream, self::MAX_BODY + 1);
			fclose($stream);
			if ($bytes === false) {
				break;
			}
			return new DataDownloadResponse($bytes, $file->getName(), 'application/octet-stream');
		}
		return new JSONResponse([], Http::STATUS_GONE);
	}

	/**
	 * The file, its owner-side user and the version manager for a versions call; nulls when the
	 * person has no access or files_versions is off. Editors only, unless viewers were granted
	 * history (docs/30 §7: editors see history by default).
	 *
	 * @return array{0: ?File, 1: ?\OCP\IUser, 2: ?object}
	 */
	private function versionContext(AccessClaims $claims): array {
		$r = $this->access->resolve($claims);
		$manager = $this->versionManager();
		if ($r === null || $manager === null || $r['flags']['UserCanWrite'] !== true) {
			return [null, null, null];
		}
		$file = $r['file'];
		$user = $file->getOwner();
		if ($user === null) {
			return [null, null, null];
		}
		return [$file, $user, $manager];
	}

	/** files_versions' manager, or null when the app is disabled. */
	private function versionManager(): ?object {
		$cls = 'OCA\\Files_Versions\\Versions\\IVersionManager';
		if (!interface_exists($cls)) {
			return null;
		}
		try {
			return \OCP\Server::get($cls);
		} catch (\Throwable) {
			return null;
		}
	}

	/**
	 * Writes the name (and our kind) on the version the save just made. Nextcloud 29+
	 * (`IMetadataVersionBackend`); older servers keep the version unlabelled, and the name is
	 * still in the file's manifest.
	 *
	 * @param array<string, string> $labels
	 */
	private function labelVersion(File $file, array $labels): void {
		$manager = $this->versionManager();
		if ($manager === null || !method_exists($manager, 'setMetadataValue')) {
			return;
		}
		try {
			foreach ($labels as $k => $v) {
				$manager->setMetadataValue($file, $file->getMTime(), $k, $v);
			}
		} catch (\Throwable $e) {
			$this->logger->warning('OpenCanvas could not label a version: {e}', ['app' => 'opencanvas', 'e' => $e->getMessage()]);
		}
	}

	/** POST {WOPISrc}: only PUT_RELATIVE (conflict copies). No LOCK/UNLOCK: OpenCanvas never sends them. */
	#[PublicPage]
	#[NoCSRFRequired]
	public function postFile(int $fileId, string $access_token = ''): Response {
		[$claims, $err] = $this->authorize($fileId, $access_token, false);
		if ($claims === null) {
			return $err;
		}
		if ($this->request->getHeader('X-WOPI-Override') !== 'PUT_RELATIVE') {
			return new JSONResponse([], Http::STATUS_NOT_IMPLEMENTED);
		}
		$r = $this->access->resolve($claims);
		if ($r === null) {
			return new JSONResponse([], Http::STATUS_NOT_FOUND);
		}
		if ($r['flags']['UserCanNotWriteRelative'] === true || $claims->userId === null) {
			return new JSONResponse([], Http::STATUS_NOT_IMPLEMENTED);
		}
		$file = $r['file'];
		$name = WopiUtil::relativeName($this->request->getHeader('X-WOPI-SuggestedTarget'), $file->getName());
		$body = $this->body();
		if ($name === null || $body === null) {
			return new JSONResponse([], Http::STATUS_BAD_REQUEST);
		}
		$parent = $file->getParent();
		$copy = $this->asEditor($claims, fn () => $parent->newFile($parent->getNonExistingName($name), $body));
		$minted = $this->tokens->mint($copy->getId(), $claims->userId, null, null, null, $claims->maxRole);
		return new JSONResponse([
			'Name' => $copy->getName(),
			'Url' => $this->config->wopiSrc($copy->getId()) . '?access_token=' . $minted['token'],
			'HostEditUrl' => $this->config->publicNextcloudFileUrl($copy->getId()),
		]);
	}

	/**
	 * Proof first (refuses anything not sent by OpenCanvas), then the token.
	 *
	 * @return array{0: ?AccessClaims, 1: ?Response}
	 */
	private function authorize(int $fileId, string $token, bool|string $contents): array {
		$suffix = is_string($contents) ? $contents : ($contents ? '/contents' : '');
		$url = $this->config->wopiSrc($fileId) . $suffix . '?access_token=' . rawurlencode($token);
		$why = null;
		foreach ([false, true] as $refresh) {
			$why = ProofVerifier::check(
				$this->discovery->proofKeys($refresh),
				$token,
				$url,
				$this->header('X-WOPI-TimeStamp'),
				$this->header('X-WOPI-Proof'),
				$this->header('X-WOPI-ProofOld'),
				$this->time->getTime(),
			);
			if ($why === null || str_contains($why, 'TimeStamp')) {
				break;
			}
		}
		if ($why !== null) {
			$this->logger->warning('OpenCanvas WOPI proof rejected: {why}', ['app' => 'opencanvas', 'why' => $why]);
			$this->discovery->markProofFailure();
			return [null, new JSONResponse([], Http::STATUS_INTERNAL_SERVER_ERROR)];
		}
		$claims = $this->tokens->check($token, $fileId);
		if ($claims === null) {
			return [null, new JSONResponse([], Http::STATUS_UNAUTHORIZED)];
		}
		return [$claims, null];
	}

	private function header(string $name): ?string {
		$v = $this->request->getHeader($name);
		return $v === '' ? null : $v;
	}

	private function body(): ?string {
		$in = fopen('php://input', 'rb');
		if ($in === false) {
			return null;
		}
		$body = stream_get_contents($in, self::MAX_BODY + 1);
		fclose($in);
		return ($body === false || strlen($body) > self::MAX_BODY) ? null : $body;
	}

	/** Writes as the editor, so versions and activity show who changed the file. */
	private function asEditor(AccessClaims $claims, callable $fn): mixed {
		$prev = $this->userSession->getUser();
		$user = $claims->userId !== null ? $this->userManager->get($claims->userId) : null;
		if ($user !== null) {
			$this->userSession->setVolatileActiveUser($user);
		}
		try {
			return $fn();
		} finally {
			if ($user !== null) {
				$this->userSession->setVolatileActiveUser($prev);
			}
		}
	}

	private function origin(): string {
		return $this->config->nextcloudOrigin();
	}
}
