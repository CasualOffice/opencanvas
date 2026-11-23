<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Tests\Unit;

use OCA\OpenCanvas\Wopi\CheckReport;
use PHPUnit\Framework\TestCase;

/** S12 connection check: four steps; a failed step greys out the ones after it. */
class CheckReportTest extends TestCase {
	private const XML_OK = '<wopi-discovery><action name="edit" ext="ocanvas"/><proof-key value="x" modulus="AQAB" exponent="AQAB"/></wopi-discovery>';
	private const XML_NO_ACTION = '<wopi-discovery><action name="edit" ext="docx"/></wopi-discovery>';

	private function statuses(array $r): array {
		return array_map(static fn ($s) => $s['status'], $r['steps']);
	}

	public function testAllGood(): void {
		$r = CheckReport::build('http://opencanvas:8080', self::XML_OK, null, true, '0.1.4', 401, 'TOKEN_INVALID', 'https://cloud.example/index.php/apps/opencanvas/wopi');
		$this->assertSame(['ok', 'ok', 'ok', 'ok'], $this->statuses($r));
		$this->assertSame('opencanvas:8080, OpenCanvas 0.1.4', $r['steps'][0]['detail']);
		$this->assertTrue($r['ok']);
	}

	public function testUnreachableSkipsTheRest(): void {
		$r = CheckReport::build('http://opencanvas:8080', null, 'timed out after 10 s', false, null, null, null, 'w');
		$this->assertSame(['fail', 'skipped', 'skipped', 'skipped'], $this->statuses($r));
		$this->assertStringContainsString('http://opencanvas:8080', $r['steps'][0]['detail']);
		$this->assertStringContainsString('allow_local_remote_servers', $r['steps'][0]['fix']);
		$this->assertFalse($r['ok']);
	}

	public function testNoOcanvasAction(): void {
		$r = CheckReport::build('http://x', self::XML_NO_ACTION, null, false, null, null, null, 'w');
		$this->assertSame(['ok', 'fail', 'skipped', 'skipped'], $this->statuses($r));
	}

	public function testNoProofKey(): void {
		$r = CheckReport::build('http://x', '<wopi-discovery><action ext="ocanvas"/></wopi-discovery>', null, false, null, null, null, 'w');
		$this->assertSame(['ok', 'ok', 'fail', 'skipped'], $this->statuses($r));
		$this->assertStringContainsString('OC_WOPI_PROOF_KEY', $r['steps'][2]['fix']);
	}

	public function testAllowListMismatch(): void {
		$r = CheckReport::build('http://x', self::XML_OK, null, true, null, 403, 'WOPISRC_NOT_ALLOWED', 'https://cloud.example/index.php/apps/opencanvas/wopi');
		$this->assertSame(['ok', 'ok', 'ok', 'fail'], $this->statuses($r));
		$this->assertSame('wopi_allowlist = ["https://cloud.example/index.php/apps/opencanvas/wopi"]', $r['steps'][3]['fix']);
	}

	public function testOpenCanvasCannotReachNextcloud(): void {
		$r = CheckReport::build('http://x', self::XML_OK, null, true, null, 502, 'HOST_UNREACHABLE', 'https://cloud.example/w');
		$this->assertSame('fail', $r['steps'][3]['status']);
		$this->assertStringContainsString('https://cloud.example/w', $r['steps'][3]['detail']);
	}

	public function testOldResponseKeysStay(): void {
		// The README's curl check reads these.
		$r = CheckReport::build('http://x', self::XML_OK, null, true, null, 401, 'TOKEN_INVALID', 'w');
		$this->assertTrue($r['discovery']);
		$this->assertTrue($r['ocanvasAction']);
		$this->assertTrue($r['proofKey']);
		$this->assertTrue($r['accepts']);
		$this->assertSame('w', $r['wopiBase']);
	}
}
