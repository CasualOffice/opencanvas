<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Wopi;

/** Small WOPI helpers with no Nextcloud dependency. */
final class WopiUtil {
	/** `LastModifiedTime`; OpenCanvas sends it back verbatim as `X-COOL-WOPI-Timestamp`. */
	public static function isoTime(int $mtime): string {
		return gmdate('Y-m-d\TH:i:s\Z', $mtime);
	}

	/**
	 * The file name for a PUT_RELATIVE `X-WOPI-SuggestedTarget` (UTF-7). A value starting with
	 * `.` is an extension for the original's base name. The result is a plain file name with the
	 * original's extension (`.ocanvas` or `.md`), or null when nothing usable is left.
	 */
	public static function relativeName(string $suggestedUtf7, string $originalName): ?string {
		$name = self::utf7($suggestedUtf7);
		$ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
		if (str_starts_with($name, '.')) {
			$name = pathinfo($originalName, PATHINFO_FILENAME) . $name;
		}
		$name = trim(str_replace(['/', '\\', "\0"], '', $name));
		if ($name === '' || $name === '.' || $name === '..') {
			return null;
		}
		if ($ext !== '' && strtolower(pathinfo($name, PATHINFO_EXTENSION)) !== $ext) {
			$name .= '.' . $ext;
		}
		return mb_substr($name, 0, 250);
	}

	/** RFC 2152 UTF-7 to UTF-8 (as OpenCanvas encodes `X-WOPI-SuggestedTarget`). */
	public static function utf7(string $s): string {
		return (string)preg_replace_callback('/\+([A-Za-z0-9+\/]*)-?/', static function (array $m): string {
			if ($m[1] === '') {
				return '+';
			}
			$bytes = (string)base64_decode($m[1] . str_repeat('=', (4 - strlen($m[1]) % 4) % 4));
			$bytes = substr($bytes, 0, strlen($bytes) - strlen($bytes) % 2);
			return (string)mb_convert_encoding($bytes, 'UTF-8', 'UTF-16BE');
		}, $s);
	}
}
