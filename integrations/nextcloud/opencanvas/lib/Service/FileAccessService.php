<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Service;

use OCA\OpenCanvas\Wopi\AccessClaims;
use OCA\OpenCanvas\Wopi\PermissionMapper;
use OCA\OpenCanvas\Wopi\Role;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\Node;
use OCP\IURLGenerator;
use OCP\IUserManager;
use OCP\Share\IManager as IShareManager;
use OCP\Share\IShare;

/**
 * Resolves a token to the file and what this person may do with it, from Nextcloud's live
 * permissions on every call (a revoked share stops working at the next WOPI call).
 */
class FileAccessService {
	public function __construct(
		private IRootFolder $rootFolder,
		private IShareManager $shareManager,
		private IUserManager $userManager,
		private IURLGenerator $urlGenerator,
		private ConfigService $config,
	) {
	}

	/**
	 * @return array{file: File, flags: array<string, bool|string>, userId: string, name: string, avatar: ?string, share: ?IShare}|null
	 */
	public function resolve(AccessClaims $c): ?array {
		if ($c->userId !== null) {
			$file = $this->rootFolder->getUserFolder($c->userId)->getFirstNodeById($c->fileId);
			if (!$file instanceof File) {
				return null;
			}
			$share = $this->receivedShare($file);
			$flags = PermissionMapper::map(
				$file->getPermissions(),
				$this->parentCreatable($file),
				$this->shareAttribute($share, 'permissions', 'download') !== false,
				false,
				$this->shareAttribute($share, 'opencanvas', 'comment') === true,
				$c->maxRole,
				$this->config->allowCommentRole(),
			);
			$user = $this->userManager->get($c->userId);
			return $flags === null ? null : [
				'file' => $file,
				'flags' => $flags,
				'userId' => $c->userId,
				'name' => $user?->getDisplayName() ?? $c->userId,
				'avatar' => $this->urlGenerator->linkToRouteAbsolute('core.avatar.getAvatar', ['userId' => $c->userId, 'size' => 64]),
				'share' => $share,
			];
		}
		// Public link (guest).
		if (!$this->config->allowPublicLinks()) {
			return null;
		}
		try {
			$share = $this->shareManager->getShareByToken((string)$c->shareToken);
		} catch (\Throwable) {
			return null;
		}
		if (!in_array($share->getShareType(), [IShare::TYPE_LINK, IShare::TYPE_EMAIL], true)) {
			return null;
		}
		$node = $share->getNode();
		$file = $node instanceof Folder ? $node->getFirstNodeById($c->fileId) : $node;
		if (!$file instanceof File || $file->getId() !== $c->fileId) {
			return null;
		}
		$perms = $share->getPermissions() & $file->getPermissions();
		$flags = PermissionMapper::map(
			$perms,
			$node instanceof Folder && ($share->getPermissions() & PermissionMapper::CREATE) !== 0,
			$this->shareAttribute($share, 'permissions', 'download') !== false,
			$share->getHideDownload(),
			false,
			$c->maxRole,
			false,
		);
		if ($flags === null) {
			return null;
		}
		// Guests never write relative files (no account to own them), like Nextcloud Office.
		$flags['UserCanNotWriteRelative'] = true;
		return [
			'file' => $file,
			'flags' => $flags,
			'userId' => 'guest-' . substr(hash('sha256', (string)$c->shareToken . '|' . (string)$c->guestId), 0, 16),
			'name' => ($c->guestName ?? '') !== '' ? (string)$c->guestName : 'Guest',
			'avatar' => null,
			'share' => $share,
		];
	}

	/** The highest role the signed-in user could open the file with (for the launch token). */
	public function maxRoleFor(string $userId, int $fileId): ?string {
		$file = $this->rootFolder->getUserFolder($userId)->getFirstNodeById($fileId);
		if (!$file instanceof File || !$file->isReadable()) {
			return null;
		}
		return Role::EDIT; // the live permissions lower it on every call
	}

	private function parentCreatable(Node $file): bool {
		try {
			return $file->getParent()->isCreatable();
		} catch (\Throwable) {
			return false;
		}
	}

	/** The share a received file comes through, if any. */
	private function receivedShare(Node $file): ?IShare {
		try {
			$storage = $file->getStorage();
			if ($storage->instanceOfStorage(\OCP\Files\Storage\ISharedStorage::class) && method_exists($storage, 'getShare')) {
				$share = $storage->getShare();
				return $share instanceof IShare ? $share : null;
			}
		} catch (\Throwable) {
		}
		return null;
	}

	private function shareAttribute(?IShare $share, string $scope, string $key): mixed {
		return $share?->getAttributes()?->getAttribute($scope, $key);
	}
}
