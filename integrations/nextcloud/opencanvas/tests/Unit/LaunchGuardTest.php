<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Tests\Unit;

use OCA\OpenCanvas\Wopi\LaunchGuard;
use PHPUnit\Framework\TestCase;

/** S13: which error a launch answers before OpenCanvas is involved. */
class LaunchGuardTest extends TestCase {
	public function testOpensWhenEverythingIsFine(): void {
		$this->assertNull(LaunchGuard::decide(true, true, true, 2_400_000));
	}

	public function testNotFoundWinsOverEverything(): void {
		// A person must not learn whether the app is set up for a file they can't see.
		$this->assertSame('NOT_FOUND', LaunchGuard::decide(false, false, false, 0));
	}

	public function testNoPermissionWhenVisibleButNotReadable(): void {
		$this->assertSame('NO_PERMISSION', LaunchGuard::decide(true, true, false, 10));
	}

	public function testNotConfigured(): void {
		$this->assertSame('NOT_CONFIGURED', LaunchGuard::decide(false, true, true, 10));
	}

	public function testTooLargeAbove100MB(): void {
		$this->assertNull(LaunchGuard::decide(true, true, true, 100 * 1024 * 1024));
		$this->assertSame('TOO_LARGE', LaunchGuard::decide(true, true, true, 100 * 1024 * 1024 + 1));
	}

	public function testHttpStatus(): void {
		$this->assertSame(404, LaunchGuard::status('NOT_FOUND'));
		$this->assertSame(403, LaunchGuard::status('NO_PERMISSION'));
		$this->assertSame(503, LaunchGuard::status('NOT_CONFIGURED'));
		$this->assertSame(413, LaunchGuard::status('TOO_LARGE'));
	}
}
