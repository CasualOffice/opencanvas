<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Wopi;

/**
 * WOPI access tokens: stateless, HMAC-SHA256 signed with the app's secret.
 *
 *   oc1.<base64url(json claims)>.<base64url(hmac)>
 *
 * Every character is URL-unreserved, so the token survives the `?access_token=` query string
 * OpenCanvas builds (and signs in the proof) without any percent-encoding. A token only says who
 * opened which file and the most it may do; every WOPI call re-checks the file's live
 * permissions in Nextcloud, so revoking a share takes effect on the next call.
 *
 * No Nextcloud dependency: unit-tested on its own (tests/Unit/TokenCodecTest.php).
 */
final class TokenCodec {
	private const PREFIX = 'oc1';
	/** OpenCanvas caps a WOPI session at 10 h; we never mint longer. */
	public const MAX_TTL = 36000;

	public function __construct(
		private string $secret,
	) {
		if (strlen($secret) < 32) {
			throw new \InvalidArgumentException('token secret must be at least 32 bytes');
		}
	}

	public function encode(AccessClaims $claims): string {
		$payload = self::b64(json_encode($claims->toArray(), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
		$signed = self::PREFIX . '.' . $payload;
		return $signed . '.' . self::b64(hash_hmac('sha256', $signed, $this->secret, true));
	}

	/**
	 * The claims of a valid, unexpired token for `$fileId`, else null. Never throws on input.
	 */
	public function decode(string $token, int $fileId, int $now): ?AccessClaims {
		if (strlen($token) > 4096) {
			return null;
		}
		$parts = explode('.', $token);
		if (count($parts) !== 3 || $parts[0] !== self::PREFIX) {
			return null;
		}
		$expected = self::b64(hash_hmac('sha256', $parts[0] . '.' . $parts[1], $this->secret, true));
		if (!hash_equals($expected, $parts[2])) {
			return null;
		}
		$json = self::unb64($parts[1]);
		if ($json === null) {
			return null;
		}
		try {
			$data = json_decode($json, true, 8, JSON_THROW_ON_ERROR);
		} catch (\JsonException) {
			return null;
		}
		$claims = is_array($data) ? AccessClaims::fromArray($data) : null;
		if ($claims === null || $claims->fileId !== $fileId || $claims->expires <= $now) {
			return null;
		}
		return $claims;
	}

	private static function b64(string $bytes): string {
		return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
	}

	private static function unb64(string $s): ?string {
		if ($s === '' || preg_match('/^[A-Za-z0-9_-]+$/', $s) !== 1) {
			return null;
		}
		$out = base64_decode(strtr($s, '-_', '+/'), true);
		return $out === false ? null : $out;
	}
}
