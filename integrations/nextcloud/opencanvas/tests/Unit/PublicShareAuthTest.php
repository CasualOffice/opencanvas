<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Tests\Unit;

use OCA\OpenCanvas\Wopi\PublicShareAuth;
use PHPUnit\Framework\TestCase;

/**
 * S7a: a password-protected link is unlocked on Nextcloud's own password page first. Nextcloud
 * 31 records that in the session key `public_link_authenticated_frontend` as a JSON map
 * {shareToken: passwordHash} (PublicShareController::storeTokenSession). The app used to read the
 * old `public_link_authenticated_token` key, so an unlocked link was always refused.
 */
class PublicShareAuthTest extends TestCase {
	public function testUnprotectedLinkNeedsNothing(): void {
		$this->assertTrue(PublicShareAuth::isUnlocked(null, 'tok', null));
	}

	public function testUnlockedInThisSession(): void {
		$session = json_encode(['other' => 'h0', 'tok' => 'hash1']);
		$this->assertTrue(PublicShareAuth::isUnlocked($session, 'tok', 'hash1'));
	}

	public function testNotUnlocked(): void {
		$this->assertFalse(PublicShareAuth::isUnlocked(null, 'tok', 'hash1'));
		$this->assertFalse(PublicShareAuth::isUnlocked(json_encode(['other' => 'hash1']), 'tok', 'hash1'));
	}

	public function testPasswordChangedSinceUnlock(): void {
		$this->assertFalse(PublicShareAuth::isUnlocked(json_encode(['tok' => 'old']), 'tok', 'new'));
	}

	public function testGarbageSession(): void {
		$this->assertFalse(PublicShareAuth::isUnlocked('not json', 'tok', 'h'));
		$this->assertFalse(PublicShareAuth::isUnlocked('tok', 'tok', 'h')); // the old key's format
	}
}
