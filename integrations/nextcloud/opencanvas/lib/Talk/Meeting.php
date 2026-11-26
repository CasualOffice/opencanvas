<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Talk;

/**
 * TALK-01: a temporary canvas for one Talk call (ADR-049, like the Jitsi one). Its bytes live in
 * the app's data, not in anyone's Files, until a moderator saves it.
 */
final class Meeting {
	public const ACTIVE = 'active';
	/** The call ended; read only until a moderator saves or discards (or 10 minutes pass). */
	public const ENDED = 'ended';
	public const SAVED = 'saved';
	public const DISCARDED = 'discarded';

	public function __construct(
		public int $id,
		public string $room,
		public string $state,
		public string $createdBy,
		public int $createdAt,
		public ?int $endedAt = null,
		public bool $guestsCanEdit = false,
		public bool $locked = false,
		/** A moderator had it open (or asked for its state) while the call ran. */
		public bool $moderatorSeen = false,
		public ?int $savedFileId = null,
		public ?string $decidedBy = null,
		/** @var array<string, string> actor id => who, everyone who opened it (role pushes) */
		public array $members = [],
	) {
	}

	public function isOpen(): bool {
		return $this->state === self::ACTIVE || $this->state === self::ENDED;
	}
}
