<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Talk;

/** A person in a Talk conversation: a user id, or a Talk guest's actor id. */
final class RoomActor {
	public function __construct(
		public readonly string $id,
		public readonly string $name,
		/** MeetingPolicy::MODERATOR, USER or GUEST */
		public readonly string $who,
	) {
	}

	public function isGuest(): bool {
		return $this->who === MeetingPolicy::GUEST;
	}
}
