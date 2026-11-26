<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Talk;

/** What the app needs from Talk (SpreedGateway; a fake in the unit tests). */
interface TalkGateway {
	/** @return array{name: string, callActive: bool}|null null when there is no such conversation */
	public function room(string $room): ?array;

	/** MeetingPolicy::MODERATOR, USER or GUEST for a participant (user id or guest actor id), else null. */
	public function whoIs(string $room, string $actorId): ?string;

	/** Shares a file with the conversation (a Talk room share), which posts it to the chat. */
	public function shareFile(int $fileId, string $room, string $userId): void;

	/** The user's Talk attachment folder ("/Talk" unless they changed it). */
	public function talkFolder(string $userId): string;
}
