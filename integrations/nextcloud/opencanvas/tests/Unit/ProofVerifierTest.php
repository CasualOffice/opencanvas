<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Tests\Unit;

use OCA\OpenCanvas\Wopi\ProofVerifier as P;
use OCA\OpenCanvas\Wopi\StarterFiles;
use OCA\OpenCanvas\Wopi\WopiUtil;
use PHPUnit\Framework\TestCase;

final class ProofVerifierTest extends TestCase {
	private const URL = 'https://cloud.example.com/index.php/apps/opencanvas/wopi/files/42?access_token=oc1.abc.def';
	private const TOKEN = 'oc1.abc.def';

	/** @return array{0: \OpenSSLAsymmetricKey, 1: string} private key, discovery-style PEM rebuilt from modulus/exponent */
	private static function key(): array {
		$k = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
		$d = openssl_pkey_get_details($k)['rsa'];
		return [$k, P::pem($d['n'], $d['e'])];
	}

	private static function sign(\OpenSSLAsymmetricKey $k, int $ticks, string $url = self::URL): string {
		openssl_sign(P::bytes(self::TOKEN, $url, $ticks), $sig, $k, OPENSSL_ALGO_SHA256);
		return base64_encode($sig);
	}

	private static function ticks(int $unix): int {
		return $unix * 10000000 + P::TICKS_AT_UNIX_EPOCH;
	}

	public function testSignedBytesLayout(): void {
		$b = P::bytes('tok', 'https://a/b?x=1', 5);
		$this->assertSame("\0\0\0\3tok\0\0\0\x0fHTTPS://A/B?X=1\0\0\0\x08\0\0\0\0\0\0\0\x05", $b);
	}

	public function testCurrentOldAndRotatedKeys(): void {
		[$cur, $curPem] = self::key();
		[$old, $oldPem] = self::key();
		$now = 1_800_000_000;
		$t = (string)self::ticks($now);
		$keys = ['current' => $curPem, 'old' => $oldPem];
		$this->assertNull(P::check($keys, self::TOKEN, self::URL, $t, self::sign($cur, (int)$t), null, $now));
		// ProofOld with the current key (OpenCanvas rotated, we have not refreshed yet).
		$this->assertNull(P::check($keys, self::TOKEN, self::URL, $t, 'AAAA', self::sign($cur, (int)$t), $now));
		// Proof with the old key (we refreshed, OpenCanvas still signs with the old one).
		$this->assertNull(P::check($keys, self::TOKEN, self::URL, $t, self::sign($old, (int)$t), null, $now));
		// ProofOld with the old key is not one of the accepted combinations.
		$this->assertNotNull(P::check($keys, self::TOKEN, self::URL, $t, null, self::sign($old, (int)$t), $now));
	}

	public function testRefusals(): void {
		[$cur, $curPem] = self::key();
		[$other] = self::key();
		$now = 1_800_000_000;
		$t = self::ticks($now);
		$keys = ['current' => $curPem, 'old' => null];
		$good = self::sign($cur, $t);
		$this->assertSame('no X-WOPI-TimeStamp', P::check($keys, self::TOKEN, self::URL, null, $good, null, $now));
		$this->assertStringContainsString('older than 20 minutes', (string)P::check($keys, self::TOKEN, self::URL, (string)self::ticks($now - 1201), self::sign($cur, self::ticks($now - 1201)), null, $now));
		$this->assertNotNull(P::check($keys, self::TOKEN, self::URL, (string)$t, self::sign($other, $t), null, $now));
		$this->assertNotNull(P::check($keys, self::TOKEN, self::URL . 'x', (string)$t, $good, null, $now)); // other URL
		$this->assertNotNull(P::check($keys, 'oc1.other.tok', self::URL, (string)$t, $good, null, $now)); // other token
		$this->assertNotNull(P::check($keys, self::TOKEN, self::URL, (string)($t + 1), $good, null, $now)); // other time
		$this->assertNotNull(P::check(['current' => null, 'old' => null], self::TOKEN, self::URL, (string)$t, $good, null, $now));
		$this->assertNotNull(P::check($keys, self::TOKEN, self::URL, (string)$t, '%%%', null, $now));
	}

	public function testKeysFromDiscovery(): void {
		$k = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
		$d = openssl_pkey_get_details($k)['rsa'];
		$xml = '<wopi-discovery><net-zone name="external-https"></net-zone><proof-key value="x" modulus="'
			. base64_encode($d['n']) . '" exponent="' . base64_encode($d['e']) . '"/></wopi-discovery>';
		$keys = P::keysFromDiscovery($xml);
		$this->assertNotNull($keys['current']);
		$this->assertNull($keys['old']);
		$this->assertSame(openssl_pkey_get_details($k)['key'], openssl_pkey_get_details(openssl_pkey_get_public($keys['current']))['key']);
		$this->assertSame(['current' => null, 'old' => null], P::keysFromDiscovery('not xml'));
	}

	public function testRelativeNames(): void {
		// OpenCanvas sends "<name> (conflict copy).ocanvas" in UTF-7.
		$this->assertSame('Plan (conflict copy).ocanvas', WopiUtil::relativeName('Plan (conflict copy).ocanvas', 'Plan.ocanvas'));
		$this->assertSame('Café (conflict copy).ocanvas', WopiUtil::relativeName('Caf+AOk- (conflict copy).ocanvas', 'Café.ocanvas'));
		$this->assertSame('a+b.ocanvas', WopiUtil::relativeName('a+-b.ocanvas', 'x.ocanvas'));
		$this->assertSame('Plan.v2.ocanvas', WopiUtil::relativeName('.v2.ocanvas', 'Plan.ocanvas'));
		$this->assertSame('etcpasswd.ocanvas', WopiUtil::relativeName('etc/passwd', 'Plan.ocanvas'));
		$this->assertSame('Plan..etcpasswd.ocanvas', WopiUtil::relativeName('../etc/passwd', 'Plan.ocanvas')); // no separator survives
		$this->assertNull(WopiUtil::relativeName('/', 'Plan.ocanvas'));
	}

	public function testStarterFiles(): void {
		$this->assertSame('', StarterFiles::bytes('blank', 'x'));
		foreach (['database' => 'database', 'whiteboard' => 'board'] as $kind => $block) {
			$bytes = StarterFiles::bytes($kind, 'Q3 plan');
			$tmp = tempnam(sys_get_temp_dir(), 'oct');
			file_put_contents($tmp, $bytes);
			$zip = new \ZipArchive();
			$this->assertTrue($zip->open($tmp));
			$doc = json_decode((string)$zip->getFromName('document.json'), true);
			$zip->close();
			unlink($tmp);
			$this->assertSame($block, $doc['content'][0]['type']);
			$this->assertSame('Q3 plan', $doc['meta']['title']);
		}
		$this->expectException(\InvalidArgumentException::class);
		StarterFiles::bytes('spreadsheet', 'x');
	}
}
