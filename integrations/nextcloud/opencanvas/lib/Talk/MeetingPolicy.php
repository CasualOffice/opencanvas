<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Talk;

use OCA\OpenCanvas\Wopi\Role;

/**
 * TALK-01 (docs/prototypes/v04-approved/nextcloud-talk.html 3a-4b): Talk roles onto canvas roles
 * for a meeting canvas. Shared files keep their own Nextcloud permissions; Talk never raises them.
 * Pure, no Nextcloud dependency.
 */
final class MeetingPolicy {
	public const MODERATOR = 'moderator';
	public const USER = 'user';
	public const GUEST = 'guest';
	/** No decision this long after the call ended: discarded. */
	public const DECISION_SECONDS = 600;

	/** Moderators always; participants while "Participants can start a canvas" is on; guests never. */
	public static function canStart(string $who, bool $participantsCanStart): bool {
		return $who === self::MODERATOR || ($who === self::USER && $participantsCanStart);
	}

	/** The canvas role now, or null when the meeting canvas is gone (saved or discarded). */
	public static function role(Meeting $m, string $who): ?string {
		if ($m->state === Meeting::ENDED) {
			return Role::VIEW;
		}
		if ($m->state !== Meeting::ACTIVE) {
			return null;
		}
		if ($who === self::MODERATOR) {
			return Role::EDIT;
		}
		if ($m->locked) {
			return Role::VIEW;
		}
		if ($who === self::GUEST) {
			return $m->guestsCanEdit ? Role::EDIT : Role::VIEW;
		}
		return Role::EDIT;
	}

	public static function canSave(Meeting $m, string $who): bool {
		return $who === self::MODERATOR && $m->isOpen();
	}

	/** Guests never download (or export) a meeting canvas. */
	public static function canDownload(string $who): bool {
		return $who !== self::GUEST;
	}

	/** Guests can edit, lock: moderators, while the call runs. */
	public static function canModerate(Meeting $m, string $who): bool {
		return $who === self::MODERATOR && $m->state === Meeting::ACTIVE;
	}

	/** The call ended: ask the moderator if one was there, else discard at once. */
	public static function callEnded(Meeting $m, int $now): void {
		if ($m->state !== Meeting::ACTIVE) {
			return;
		}
		$m->state = $m->moderatorSeen ? Meeting::ENDED : Meeting::DISCARDED;
		$m->endedAt = $now;
	}

	/** Discards an unanswered ended meeting after the decision window; true when it did. */
	public static function settle(Meeting $m, int $now): bool {
		if ($m->state === Meeting::ENDED && $m->endedAt !== null && $now >= $m->endedAt + self::DECISION_SECONDS) {
			$m->state = Meeting::DISCARDED;
			return true;
		}
		return false;
	}
}
