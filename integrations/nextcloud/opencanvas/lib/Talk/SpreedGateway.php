<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Talk;

use OCP\App\IAppManager;
use OCP\Constants;
use OCP\Files\IRootFolder;
use OCP\IAppConfig;
use OCP\IConfig;
use OCP\Share\IManager as IShareManager;
use OCP\Share\IShare;
use Psr\Log\LoggerInterface;

/**
 * TalkGateway over Talk's (spreed) PHP classes, the way other apps (Deck, Collectives) integrate.
 * Talk has no OCP API for participants or call state, so its classes are resolved by name at call
 * time and every call degrades to "no such conversation" when Talk is disabled or changed. Checked
 * against Talk 21 (Nextcloud 31); the scripted run (test/e2e.sh) exercises it in a real server.
 *
 * Actor ids: a user's uid, or `guest:<Talk guest actor id>`.
 */
class SpreedGateway implements TalkGateway {
	private const GUEST = 'guest:';
	// Talk's Participant::* types.
	private const OWNER = 1;
	private const MODERATOR = 2;
	private const GUEST_MODERATOR = 6;

	public function __construct(
		private IAppManager $apps,
		private IShareManager $shares,
		private IRootFolder $root,
		private IConfig $config,
		private IAppConfig $appConfig,
		private LoggerInterface $logger,
	) {
	}

	public function available(): bool {
		return $this->apps->isEnabledForUser('spreed') && class_exists('OCA\\Talk\\Manager');
	}

	public function room(string $room): ?array {
		$r = $this->talkRoom($room);
		if ($r === null) {
			return null;
		}
		return ['name' => (string)$r->getName(), 'callActive' => $this->callActive($r)];
	}

	public function whoIs(string $room, string $actorId): ?string {
		$p = $this->participant($room, $actorId);
		return $p === null ? null : $this->whoOf($p);
	}

	/** The signed-out visitor of a public conversation, from their Talk session in this browser. */
	public function currentGuest(string $room): ?RoomActor {
		$r = $this->talkRoom($room);
		if ($r === null || !class_exists('OCA\\Talk\\TalkSession')) {
			return null;
		}
		try {
			$session = \OCP\Server::get('OCA\\Talk\\TalkSession')->getSessionForRoom($room);
			if (!is_string($session) || $session === '') {
				return null;
			}
			$p = $this->participants()->getParticipantBySession($r, $session);
			$a = $p->getAttendee();
			if ($a->getActorType() !== 'guests') {
				return null;
			}
			return new RoomActor(self::GUEST . $a->getActorId(), (string)($a->getDisplayName() ?: 'Guest'), $this->whoOf($p));
		} catch (\Throwable) {
			return null;
		}
	}

	public function shareFile(int $fileId, string $room, string $userId): void {
		$node = $this->root->getUserFolder($userId)->getFirstNodeById($fileId);
		if ($node === null) {
			throw new TalkException('NOT_FOUND');
		}
		$share = $this->shares->newShare();
		$share->setNode($node)
			->setShareType(IShare::TYPE_ROOM)
			->setSharedBy($userId)
			->setSharedWith($room)
			->setPermissions(Constants::PERMISSION_READ | Constants::PERMISSION_UPDATE | Constants::PERMISSION_SHARE);
		$this->shares->createShare($share);
	}

	/** Whether this user may open the file (the "can't open this canvas yet" count, 1a). */
	public function canOpen(string $userId, int $fileId): bool {
		try {
			$node = $this->root->getUserFolder($userId)->getFirstNodeById($fileId);
			return $node !== null && $node->isReadable();
		} catch (\Throwable) {
			return false;
		}
	}

	/** Shares a file with the conversation at `view` or `edit` (1a "Share the file with the conversation"). */
	public function shareWithRoom(int $fileId, string $room, string $userId, string $level): void {
		$node = $this->root->getUserFolder($userId)->getFirstNodeById($fileId);
		if ($node === null) {
			throw new TalkException('NOT_FOUND');
		}
		$share = $this->shares->newShare();
		$perm = Constants::PERMISSION_READ | ($level === 'edit' ? Constants::PERMISSION_UPDATE : 0);
		$share->setNode($node)->setShareType(IShare::TYPE_ROOM)->setSharedBy($userId)->setSharedWith($room)->setPermissions($perm);
		$this->shares->createShare($share);
	}

	public function talkFolder(string $userId): string {
		$default = $this->appConfig->getValueString('spreed', 'default_attachment_folder', '/Talk');
		$f = (string)$this->config->getUserValue($userId, 'spreed', 'attachment_folder', $default);
		return $f === '' ? '/Talk' : $f;
	}

	/** @return list<string> user ids in the conversation (the access count of 1a); guests counted apart. */
	public function members(string $room): array {
		$r = $this->talkRoom($room);
		if ($r === null) {
			return [];
		}
		$out = [];
		try {
			foreach ($this->participants()->getParticipantsForRoom($r) as $p) {
				$a = $p->getAttendee();
				$out[] = $a->getActorType() === 'users' ? (string)$a->getActorId() : self::GUEST . $a->getActorId();
			}
		} catch (\Throwable $e) {
			$this->logger->warning('OpenCanvas could not list Talk participants: {e}', ['app' => 'opencanvas', 'e' => $e->getMessage()]);
		}
		return $out;
	}

	private function talkRoom(string $room): ?object {
		if (!$this->available() || preg_match('/^[a-z0-9]{4,32}$/i', $room) !== 1) {
			return null;
		}
		try {
			return \OCP\Server::get('OCA\\Talk\\Manager')->getRoomByToken($room);
		} catch (\Throwable) {
			return null;
		}
	}

	private function participant(string $room, string $actorId): ?object {
		$r = $this->talkRoom($room);
		if ($r === null) {
			return null;
		}
		[$type, $id] = str_starts_with($actorId, self::GUEST) ? ['guests', substr($actorId, strlen(self::GUEST))] : ['users', $actorId];
		try {
			return $this->participants()->getParticipantByActor($r, $type, $id);
		} catch (\Throwable) {
			return null;
		}
	}

	private function whoOf(object $p): string {
		$a = $p->getAttendee();
		$type = (int)$a->getParticipantType();
		if (in_array($type, [self::OWNER, self::MODERATOR, self::GUEST_MODERATOR], true)) {
			return MeetingPolicy::MODERATOR;
		}
		return $a->getActorType() === 'users' ? MeetingPolicy::USER : MeetingPolicy::GUEST;
	}

	private function callActive(object $r): bool {
		try {
			// Talk's own `hasCall`: the call started and has not ended for everyone.
			return $r->getActiveSince() !== null;
		} catch (\Throwable) {
			return false;
		}
	}

	private function participants(): object {
		return \OCP\Server::get('OCA\\Talk\\Service\\ParticipantService');
	}
}
