<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Talk;

/** A meeting canvas's bytes (app data, never anyone's Files) and saving one into Files. */
interface MeetingFiles {
	public function create(int $id, string $bytes): void;

	public function read(int $id): ?string;

	public function write(int $id, string $bytes): void;

	public function delete(int $id): void;

	/** Writes `$name` (made unique) into the user's `$folder` and returns the new file id. */
	public function saveToTalk(string $userId, string $folder, string $name, string $bytes): int;
}
