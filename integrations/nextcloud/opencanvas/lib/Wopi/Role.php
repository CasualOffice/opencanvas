<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Wopi;

/** OpenCanvas roles (docs/05 §3), ordered view < comment < edit. */
final class Role {
	public const VIEW = 'view';
	public const COMMENT = 'comment';
	public const EDIT = 'edit';

	private const RANK = [self::VIEW => 1, self::COMMENT => 2, self::EDIT => 3];

	public static function isValid(mixed $role): bool {
		return is_string($role) && isset(self::RANK[$role]);
	}

	/** The lower of two roles. */
	public static function min(string $a, string $b): string {
		return self::RANK[$a] <= self::RANK[$b] ? $a : $b;
	}
}
