<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Service;

use OCA\OpenCanvas\Wopi\AccessClaims;
use OCA\OpenCanvas\Wopi\TokenCodec;
use OCP\AppFramework\Utility\ITimeFactory;

/** Mints and checks WOPI access tokens with the app's secret (see TokenCodec). */
class TokenService {
	public function __construct(
		private ConfigService $config,
		private ITimeFactory $time,
	) {
	}

	/** @return array{token: string, ttlMs: int} `ttlMs` is `access_token_ttl` (ms since the epoch) */
	public function mint(int $fileId, ?string $userId, ?string $shareToken, ?string $guestId, ?string $guestName, string $maxRole): array {
		$exp = $this->time->getTime() + min($this->config->tokenTtl(), TokenCodec::MAX_TTL);
		$claims = new AccessClaims($fileId, $userId, $shareToken, $guestId, $guestName, $maxRole, $exp);
		return ['token' => $this->codec()->encode($claims), 'ttlMs' => $exp * 1000];
	}

	public function check(string $token, int $fileId): ?AccessClaims {
		return $this->codec()->decode($token, $fileId, $this->time->getTime());
	}

	private function codec(): TokenCodec {
		return new TokenCodec($this->config->tokenSecret());
	}
}
