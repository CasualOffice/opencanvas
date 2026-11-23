<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Wopi;

/**
 * What a WOPI access token carries. Exactly one of `userId` (a signed-in Nextcloud user) or
 * `shareToken` (a public link share, opened by a guest) is set.
 */
final class AccessClaims {
	public function __construct(
		public readonly int $fileId,
		public readonly ?string $userId,
		public readonly ?string $shareToken,
		/** Guests only: a random per-browser id, so two guests are two people. */
		public readonly ?string $guestId,
		/** Guests only: the name they typed, display only. */
		public readonly ?string $guestName,
		/** The most this token may do (`Role::*`); the live share permissions may lower it. */
		public readonly string $maxRole,
		public readonly int $expires,
	) {
	}

	public function isGuest(): bool {
		return $this->userId === null;
	}

	public function toArray(): array {
		return array_filter([
			'f' => $this->fileId,
			'u' => $this->userId,
			's' => $this->shareToken,
			'g' => $this->guestId,
			'n' => $this->guestName,
			'r' => $this->maxRole,
			'e' => $this->expires,
		], static fn ($v) => $v !== null);
	}

	public static function fromArray(array $a): ?self {
		$str = static fn (string $k): ?string => isset($a[$k]) && is_string($a[$k]) && $a[$k] !== '' ? $a[$k] : null;
		if (!isset($a['f'], $a['e'], $a['r']) || !is_int($a['f']) || !is_int($a['e']) || !Role::isValid($a['r'])) {
			return null;
		}
		$user = $str('u');
		$share = $str('s');
		if (($user === null) === ($share === null)) {
			return null; // exactly one identity
		}
		return new self($a['f'], $user, $share, $str('g'), $str('n'), $a['r'], $a['e']);
	}
}
