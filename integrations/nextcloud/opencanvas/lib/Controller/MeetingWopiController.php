<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Controller;

use OCA\OpenCanvas\Service\ConfigService;
use OCA\OpenCanvas\Service\DiscoveryService;
use OCA\OpenCanvas\Service\TokenService;
use OCA\OpenCanvas\Talk\MeetingService;
use OCA\OpenCanvas\Wopi\AccessClaims;
use OCA\OpenCanvas\Wopi\Role;
use OCA\OpenCanvas\Wopi\WopiUtil;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\DataDownloadResponse;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IRequest;
use OCP\IUserManager;
use Psr\Log\LoggerInterface;

/**
 * TALK-01: the WOPI host for meeting canvases, `{base}/wopi/meetings/{id}` (under the same
 * allow-listed prefix as files). Same proof and tokens as files (the token's file id is `-id`);
 * the role is read live from the meeting and the person's Talk participation on every call.
 */
class MeetingWopiController extends Controller {
	use WopiProof;

	private const MAX_BODY = 100 * 1024 * 1024;

	public function __construct(
		string $appName,
		IRequest $request,
		private ConfigService $config,
		private TokenService $tokens,
		private DiscoveryService $discovery,
		private MeetingService $meetings,
		private IUserManager $users,
		private ITimeFactory $time,
		private LoggerInterface $logger,
	) {
		parent::__construct($appName, $request);
	}

	#[PublicPage]
	#[NoCSRFRequired]
	public function checkFileInfo(int $meetingId, string $access_token = ''): Response {
		[$c, $role, $err] = $this->authorize($meetingId, $access_token, '');
		if ($c === null) {
			return $err;
		}
		$bytes = (string)$this->meetings->read($meetingId);
		$guest = $c->userId === null;
		$edit = $role === Role::EDIT;
		return new JSONResponse([
			'BaseFileName' => 'Meeting canvas.ocanvas',
			'Size' => strlen($bytes),
			'Version' => substr(hash('sha256', $bytes), 0, 16),
			'LastModifiedTime' => WopiUtil::isoTime($this->time->getTime()),
			'OwnerId' => 'talk',
			'UserId' => $this->actorId($c),
			// Cursors carry the Talk display name; guests are labelled (4b).
			'UserFriendlyName' => $guest ? (($c->guestName ?? '') !== '' ? $c->guestName . ' (Guest)' : 'Guest') : ($this->users->getDisplayName((string)$c->userId) ?? (string)$c->userId),
			'PostMessageOrigin' => $this->config->nextcloudOrigin(),
			'SupportsLocks' => false,
			'SupportsUpdate' => true,
			'OpenCanvas_SupportsVersions' => false,
			'UserCanWrite' => $edit,
			'ReadOnly' => !$edit,
			'OpenCanvas_UserCanComment' => $edit,
			'UserCanNotWriteRelative' => true,
			// Guests never save or download a meeting canvas (4b).
			'DisableExport' => $guest,
			'DisablePrint' => $guest,
			'HideExportOption' => $guest,
		]);
	}

	#[PublicPage]
	#[NoCSRFRequired]
	public function getFile(int $meetingId, string $access_token = ''): Response {
		[$c, , $err] = $this->authorize($meetingId, $access_token, '/contents');
		if ($c === null) {
			return $err;
		}
		$bytes = $this->meetings->read($meetingId);
		return $bytes === null ? new JSONResponse([], Http::STATUS_NOT_FOUND) : new DataDownloadResponse($bytes, 'Meeting canvas.ocanvas', 'application/octet-stream');
	}

	#[PublicPage]
	#[NoCSRFRequired]
	public function putFile(int $meetingId, string $access_token = ''): Response {
		[$c, $role, $err] = $this->authorize($meetingId, $access_token, '/contents');
		if ($c === null) {
			return $err;
		}
		if ($role !== Role::EDIT) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED); // OpenCanvas tries the next editor's token
		}
		$in = fopen('php://input', 'rb');
		$body = $in === false ? false : stream_get_contents($in, self::MAX_BODY + 1);
		if ($in !== false) {
			fclose($in);
		}
		if ($body === false || strlen($body) > self::MAX_BODY) {
			return new JSONResponse([], Http::STATUS_REQUEST_ENTITY_TOO_LARGE);
		}
		if (!$this->meetings->write($meetingId, $body)) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		return new JSONResponse(['LastModifiedTime' => WopiUtil::isoTime($this->time->getTime())]);
	}

	/** @return array{0: ?AccessClaims, 1: ?string, 2: ?Response} */
	private function authorize(int $id, string $token, string $suffix): array {
		$url = $this->config->meetingWopiSrc($id) . $suffix . '?access_token=' . rawurlencode($token);
		$refused = $this->proofError($url, $token);
		if ($refused !== null) {
			return [null, null, $refused];
		}
		$c = $this->tokens->check($token, -$id);
		if ($c === null) {
			return [null, null, new JSONResponse([], Http::STATUS_UNAUTHORIZED)];
		}
		$role = $this->meetings->roleOf($id, $this->actorId($c));
		if ($role === null) {
			return [null, null, new JSONResponse([], Http::STATUS_NOT_FOUND)];
		}
		if ($c->userId === null && $role === Role::EDIT && !str_starts_with((string)$c->shareToken, 'talk:')) {
			$role = Role::VIEW;
		}
		return [$c, $role, null];
	}

	/** A user's uid, or the guest's `guest:<Talk actor id>` (kept in the token's guest id). */
	private function actorId(AccessClaims $c): string {
		return $c->userId ?? (string)$c->guestId;
	}
}
