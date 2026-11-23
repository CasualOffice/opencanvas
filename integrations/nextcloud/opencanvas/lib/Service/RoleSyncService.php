<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Service;

use OCA\OpenCanvas\Wopi\AccessClaims;
use OCA\OpenCanvas\Wopi\Role;
use OCP\Files\File;
use OCP\Files\Node;
use OCP\Http\Client\IClientService;
use OCP\IGroupManager;
use OCP\Share\IShare;
use Psr\Log\LoggerInterface;

/**
 * Pushes share changes to open canvases (docs/05 §7 role API): when a share on an `.ocanvas`
 * is deleted or its permissions change, each affected person's open session is switched to
 * their new live role (`edit`, `comment`, `view`) or closed (`none`) at once. Without this a
 * revoked person keeps editing until their session ends, because WOPI re-checks access only on
 * the next WOPI call. Needs `opencanvas_api_key` (the host's `api_key` in OpenCanvas).
 */
class RoleSyncService {
	/** A group share's members are each updated; very large groups are capped. */
	private const MAX_USERS = 500;

	public function __construct(
		private ConfigService $config,
		private FileAccessService $access,
		private IGroupManager $groupManager,
		private IClientService $clientService,
		private LoggerInterface $logger,
	) {
	}

	public function shareChanged(IShare $share): void {
		try {
			$node = $share->getNode();
		} catch (\Throwable) {
			return;
		}
		$this->sync($node, $share->getShareType(), (string)$share->getSharedWith());
	}

	/** From the legacy `post_update_permissions` hook (Nextcloud has no typed update event). */
	public function permissionsUpdated(array $p): void {
		if (($p['itemType'] ?? '') !== 'file') {
			return;
		}
		$this->syncById((int)($p['itemSource'] ?? 0), (int)($p['shareType'] ?? -1), (string)($p['shareWith'] ?? ''), (string)($p['uidOwner'] ?? ''));
	}

	private function syncById(int $fileId, int $type, string $with, string $owner): void {
		if ($fileId <= 0 || $owner === '') {
			return;
		}
		$this->sync(null, $type, $with, $fileId);
	}

	private function sync(?Node $node, int $type, string $with, ?int $fileId = null): void {
		if ($node !== null) {
			if (!$node instanceof File || !str_ends_with(strtolower($node->getName()), '.ocanvas')) {
				return; // folder shares and other files: not handled yet (DESIGN.md §5)
			}
			$fileId = $node->getId();
		}
		if ($fileId === null || $this->config->apiKey() === '' || $this->config->internalUrl() === '') {
			return;
		}
		$users = match ($type) {
			IShare::TYPE_USER => [$with],
			IShare::TYPE_GROUP => array_map(static fn ($u) => $u->getUID(), array_slice($this->groupManager->get($with)?->getUsers() ?? [], 0, self::MAX_USERS)),
			default => [],
		};
		foreach ($users as $uid) {
			$this->push($fileId, $uid, $this->liveRole($fileId, $uid));
		}
	}

	/** The role this user has now, through any share; `none` when they lost access. */
	public function liveRole(int $fileId, string $uid): string {
		try {
			$r = $this->access->resolve(new AccessClaims($fileId, $uid, null, null, null, Role::EDIT, PHP_INT_MAX));
		} catch (\Throwable) {
			$r = null;
		}
		return $r === null ? 'none' : (string)$r['flags']['role'];
	}

	private function push(int $fileId, string $uid, string $role): void {
		$url = $this->config->internalUrl() . '/v1/files/' . rawurlencode($this->config->wopiSrc($fileId)) . '/role';
		try {
			$this->clientService->newClient()->post($url, [
				'headers' => [
					'X-OpenCanvas-Host' => $this->config->hostId(),
					'X-OpenCanvas-Key' => $this->config->apiKey(),
					'Content-Type' => 'application/json',
				],
				'body' => json_encode(['userId' => $uid, 'role' => $role]),
				'timeout' => 5,
				'allow_redirects' => false,
			]);
		} catch (\Throwable $e) {
			// The WOPI calls still re-check access; this only makes the change immediate.
			$this->logger->warning('OpenCanvas role update failed', ['app' => 'opencanvas', 'fileId' => $fileId, 'exception' => $e->getMessage()]);
		}
	}
}
