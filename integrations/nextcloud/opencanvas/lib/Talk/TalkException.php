<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Talk;

/** A refused Talk action; the message is the code the panel shows (NOT_FOUND, FORBIDDEN, NO_CALL, GONE). */
final class TalkException extends \RuntimeException {
	public function status(): int {
		return match ($this->getMessage()) {
			'NOT_FOUND' => 404,
			'FORBIDDEN' => 403,
			'GONE' => 410,
			default => 409,
		};
	}
}
