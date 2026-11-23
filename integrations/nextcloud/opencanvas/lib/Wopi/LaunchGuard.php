<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Wopi;

/**
 * Decides whether a canvas may be launched, before OpenCanvas is involved, and which shared
 * error (UI-SCREENS S13) to show otherwise. Pure function, no Nextcloud dependency.
 */
final class LaunchGuard {
	/** OpenCanvas reads .ocanvas files up to 100 MB (the WOPI GetFile cap matches). */
	public const MAX_BYTES = 100 * 1024 * 1024;

	public static function decide(bool $configured, bool $found, bool $readable, int|float $size): ?string {
		if (!$found) {
			return 'NOT_FOUND'; // first: nobody learns anything about a file they can't see
		}
		if (!$readable) {
			return 'NO_PERMISSION';
		}
		if (!$configured) {
			return 'NOT_CONFIGURED';
		}
		if ($size > self::MAX_BYTES) {
			return 'TOO_LARGE';
		}
		return null;
	}

	public static function status(string $code): int {
		return match ($code) {
			'NOT_FOUND' => 404,
			'NO_PERMISSION', 'PASSWORD_REQUIRED' => 403,
			'TOO_LARGE' => 413,
			default => 503,
		};
	}
}
