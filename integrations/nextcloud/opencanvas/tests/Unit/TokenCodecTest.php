<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Tests\Unit;

use OCA\OpenCanvas\Wopi\AccessClaims;
use OCA\OpenCanvas\Wopi\Role;
use OCA\OpenCanvas\Wopi\TokenCodec;
use PHPUnit\Framework\TestCase;

final class TokenCodecTest extends TestCase {
	private const SECRET = 'test-secret-0123456789abcdefghijklmnopqrstuvwxyz';
	private const NOW = 1_800_000_000;

	private function user(int $exp = self::NOW + 600): AccessClaims {
		return new AccessClaims(42, 'alice', null, null, null, Role::EDIT, $exp);
	}

	public function testRoundTrip(): void {
		$codec = new TokenCodec(self::SECRET);
		$token = $codec->encode($this->user());
		$c = $codec->decode($token, 42, self::NOW);
		$this->assertNotNull($c);
		$this->assertSame('alice', $c->userId);
		$this->assertSame(Role::EDIT, $c->maxRole);
		$this->assertFalse($c->isGuest());
	}

	public function testTokenIsQuerySafe(): void {
		$token = (new TokenCodec(self::SECRET))->encode(new AccessClaims(7, null, 'AbC123', 'g1', 'Ünïcode Guest', Role::VIEW, self::NOW + 60));
		$this->assertMatchesRegularExpression('/^[A-Za-z0-9._-]+$/', $token);
		$this->assertSame($token, rawurlencode($token));
	}

	public function testGuestClaims(): void {
		$codec = new TokenCodec(self::SECRET);
		$c = $codec->decode($codec->encode(new AccessClaims(7, null, 'AbC123', 'g1', 'Visitor', Role::VIEW, self::NOW + 60)), 7, self::NOW);
		$this->assertNotNull($c);
		$this->assertTrue($c->isGuest());
		$this->assertSame('AbC123', $c->shareToken);
		$this->assertSame('Visitor', $c->guestName);
	}

	public function testExpiredTokenIsRefused(): void {
		$codec = new TokenCodec(self::SECRET);
		$token = $codec->encode($this->user(self::NOW));
		$this->assertNull($codec->decode($token, 42, self::NOW));
		$this->assertNotNull($codec->decode($token, 42, self::NOW - 1));
	}

	public function testTokenIsBoundToItsFile(): void {
		$codec = new TokenCodec(self::SECRET);
		$this->assertNull($codec->decode($codec->encode($this->user()), 43, self::NOW));
	}

	public function testOtherSecretIsRefused(): void {
		$token = (new TokenCodec(self::SECRET))->encode($this->user());
		$this->assertNull((new TokenCodec(strrev(self::SECRET)))->decode($token, 42, self::NOW));
	}

	public function testTamperedPayloadIsRefused(): void {
		$codec = new TokenCodec(self::SECRET);
		[$p, $body, $sig] = explode('.', $codec->encode($this->user()));
		$forged = rtrim(strtr(base64_encode(json_encode(['f' => 42, 'u' => 'mallory', 'r' => 'edit', 'e' => self::NOW + 600])), '+/', '-_'), '=');
		$this->assertNull($codec->decode("$p.$forged.$sig", 42, self::NOW));
		$this->assertNull($codec->decode("$p.$body.", 42, self::NOW));
		$this->assertNull($codec->decode("$p.$body", 42, self::NOW));
		$this->assertNull($codec->decode('', 42, self::NOW));
		$this->assertNull($codec->decode(str_repeat('a', 5000), 42, self::NOW));
	}

	public function testClaimsNeedExactlyOneIdentityAndAValidRole(): void {
		$this->assertNull(AccessClaims::fromArray(['f' => 1, 'r' => 'edit', 'e' => 2]));
		$this->assertNull(AccessClaims::fromArray(['f' => 1, 'u' => 'a', 's' => 'b', 'r' => 'edit', 'e' => 2]));
		$this->assertNull(AccessClaims::fromArray(['f' => 1, 'u' => 'a', 'r' => 'owner', 'e' => 2]));
		$this->assertNotNull(AccessClaims::fromArray(['f' => 1, 'u' => 'a', 'r' => 'comment', 'e' => 2]));
	}

	public function testShortSecretIsRejected(): void {
		$this->expectException(\InvalidArgumentException::class);
		new TokenCodec('short');
	}
}
