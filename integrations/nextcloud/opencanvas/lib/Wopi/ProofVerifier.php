<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Wopi;

/**
 * Verifies the WOPI proof headers OpenCanvas sends on every call (docs/05 §6 "Proof keys";
 * Microsoft WOPI "Verifying that requests originate from Office for the web using proof keys").
 *
 * Signed bytes: be32(len token) ‖ token ‖ be32(len URL) ‖ UPPER(URL) ‖ be32(8) ‖ be64(ticks),
 * RSASSA-PKCS1-v1_5 / SHA-256. Accepted when X-WOPI-Proof verifies with the current key, or
 * X-WOPI-ProofOld with the current key, or X-WOPI-Proof with the old key; timestamps older than
 * 20 minutes are refused. No Nextcloud dependency.
 */
final class ProofVerifier {
	/** .NET ticks at 1970-01-01T00:00:00Z. */
	public const TICKS_AT_UNIX_EPOCH = 621355968000000000;
	public const MAX_AGE_SECONDS = 1200;

	/**
	 * @param array{current: ?string, old: ?string} $keys PEM public keys from discovery
	 * @return string|null null when the call is genuine, else why not (for the log; no secrets)
	 */
	public static function check(
		array $keys,
		string $accessToken,
		string $url,
		?string $timestamp,
		?string $proof,
		?string $proofOld,
		int $nowUnix,
	): ?string {
		if ($timestamp === null || preg_match('/^\d{1,19}$/', $timestamp) !== 1) {
			return 'no X-WOPI-TimeStamp';
		}
		$ticks = (int)$timestamp;
		$unix = intdiv($ticks - self::TICKS_AT_UNIX_EPOCH, 10000000);
		if ($nowUnix - $unix > self::MAX_AGE_SECONDS) {
			return 'X-WOPI-TimeStamp older than 20 minutes';
		}
		if ($keys['current'] === null) {
			return 'no proof-key in OpenCanvas discovery';
		}
		$msg = self::bytes($accessToken, $url, $ticks);
		if (self::verify($keys['current'], $msg, $proof)
			|| self::verify($keys['current'], $msg, $proofOld)
			|| ($keys['old'] !== null && self::verify($keys['old'], $msg, $proof))) {
			return null;
		}
		return 'X-WOPI-Proof does not verify';
	}

	public static function bytes(string $accessToken, string $url, int $ticks): string {
		$u = strtoupper($url);
		return pack('N', strlen($accessToken)) . $accessToken
			. pack('N', strlen($u)) . $u
			. pack('N', 8) . pack('J', $ticks);
	}

	private static function verify(string $pem, string $msg, ?string $sigB64): bool {
		if ($sigB64 === null || $sigB64 === '') {
			return false;
		}
		$sig = base64_decode($sigB64, true);
		if ($sig === false) {
			return false;
		}
		$key = openssl_pkey_get_public($pem);
		return $key !== false && openssl_verify($msg, $sig, $key, OPENSSL_ALGO_SHA256) === 1;
	}

	/**
	 * The proof keys of an OpenCanvas discovery document as PEM, from the `modulus`/`exponent`
	 * attributes (base64, big-endian) of `<proof-key>`.
	 *
	 * @return array{current: ?string, old: ?string}
	 */
	public static function keysFromDiscovery(string $xml): array {
		$none = ['current' => null, 'old' => null];
		$prev = libxml_use_internal_errors(true);
		$doc = simplexml_load_string($xml, \SimpleXMLElement::class, LIBXML_NONET);
		libxml_use_internal_errors($prev);
		if ($doc === false) {
			return $none;
		}
		$pk = $doc->xpath('//proof-key');
		if (!$pk) {
			return $none;
		}
		$a = $pk[0]->attributes();
		$pem = static function (?string $mod, ?string $exp): ?string {
			$m = $mod !== null ? base64_decode($mod, true) : false;
			$e = $exp !== null ? base64_decode($exp, true) : false;
			return ($m === false || $e === false || $m === '' || $e === '') ? null : self::pem($m, $e);
		};
		return [
			'current' => $pem((string)($a['modulus'] ?? '') ?: null, (string)($a['exponent'] ?? '') ?: null),
			'old' => $pem((string)($a['oldmodulus'] ?? '') ?: null, (string)($a['oldexponent'] ?? '') ?: null),
		];
	}

	/** SubjectPublicKeyInfo PEM for an RSA key given its modulus and exponent bytes. */
	public static function pem(string $modulus, string $exponent): string {
		$int = static function (string $b): string {
			$b = ltrim($b, "\0");
			if ($b === '' || ord($b[0]) > 0x7f) {
				$b = "\0" . $b;
			}
			return self::der(0x02, $b);
		};
		$rsaKey = self::der(0x30, $int($modulus) . $int($exponent));
		$algo = self::der(0x30, self::der(0x06, "\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01") . "\x05\x00");
		$spki = self::der(0x30, $algo . self::der(0x03, "\0" . $rsaKey));
		return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($spki), 64, "\n") . "-----END PUBLIC KEY-----\n";
	}

	private static function der(int $tag, string $body): string {
		$len = strlen($body);
		if ($len < 0x80) {
			return chr($tag) . chr($len) . $body;
		}
		$l = ltrim(pack('N', $len), "\0");
		return chr($tag) . chr(0x80 | strlen($l)) . $l . $body;
	}
}
