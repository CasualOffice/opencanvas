<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Talk;

/** Where meeting canvases and the per-conversation settings are kept (DbMeetingStore). */
interface MeetingStore {
	/** The conversation's most recent meeting canvas, in any state. */
	public function latest(string $room): ?Meeting;

	public function get(int $id): ?Meeting;

	/** Stores a new meeting and sets its id. */
	public function insert(Meeting $m): Meeting;

	public function update(Meeting $m): void;

	/** @return Meeting[] ended meetings whose call ended at or before `$before` */
	public function pending(int $before): array;

	/** "Participants can start a canvas", on unless a moderator turned it off. */
	public function participantsCanStart(string $room): bool;

	public function setParticipantsCanStart(string $room, bool $on): void;

	/** @return array{by: string, name: string, canvas: string, block: ?string}|null */
	public function follow(string $room): ?array;

	public function setFollow(string $room, ?array $follow): void;
}
