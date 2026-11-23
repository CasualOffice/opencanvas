<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Wopi;

/**
 * Was this password-protected link unlocked in this browser session? Nextcloud's public share
 * controller (OCP\AppFramework\PublicShareController, Nextcloud 30-32) stores a JSON map
 * {shareToken: passwordHash} in the session key below after the password page. Comparing the hash
 * means a changed password locks the link again. Pure function.
 */
final class PublicShareAuth {
	public const SESSION_KEY = 'public_link_authenticated_frontend';

	public static function isUnlocked(mixed $sessionValue, string $shareToken, ?string $passwordHash): bool {
		if ($passwordHash === null || $passwordHash === '') {
			return true;
		}
		$map = is_string($sessionValue) ? json_decode($sessionValue, true) : null;
		if (!is_array($map) || !isset($map[$shareToken]) || !is_string($map[$shareToken])) {
			return false;
		}
		return hash_equals($passwordHash, $map[$shareToken]);
	}
}
