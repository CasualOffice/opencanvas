<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Runs tests/Unit with plain `php` when PHPUnit is not installed (no composer here), using a
// minimal stand-in for the assertions the tests use. With PHPUnit: `phpunit -c phpunit.xml`.
//
//   php tests/run-without-phpunit.php

namespace PHPUnit\Framework {
	if (!class_exists(TestCase::class)) {
		class AssertionFailed extends \Exception {
		}

		abstract class TestCase {
			public ?string $expected = null;

			private static function fail(string $m): never {
				throw new AssertionFailed($m);
			}
			public function assertSame(mixed $a, mixed $b, string $m = ''): void {
				if ($a !== $b) {
					self::fail($m ?: 'expected ' . var_export($a, true) . ', got ' . var_export($b, true));
				}
			}
			public function assertTrue(mixed $v, string $m = ''): void {
				$this->assertSame(true, $v, $m);
			}
			public function assertFalse(mixed $v, string $m = ''): void {
				$this->assertSame(false, $v, $m);
			}
			public function assertNull(mixed $v, string $m = ''): void {
				$this->assertSame(null, $v, $m);
			}
			public function assertNotNull(mixed $v, string $m = ''): void {
				if ($v === null) {
					self::fail($m ?: 'expected not null');
				}
			}
			public function assertMatchesRegularExpression(string $re, string $s): void {
				if (preg_match($re, $s) !== 1) {
					self::fail("$s does not match $re");
				}
			}
			public function assertStringContainsString(string $needle, string $s): void {
				if (!str_contains($s, $needle)) {
					self::fail("'$s' lacks '$needle'");
				}
			}
			public function expectException(string $class): void {
				$this->expected = $class;
			}
		}
	}
}

namespace {
	require __DIR__ . '/bootstrap.php';
	$failed = 0;
	$passed = 0;
	foreach (glob(__DIR__ . '/Unit/*Test.php') as $file) {
		require_once $file;
		$class = 'OCA\\OpenCanvas\\Tests\\Unit\\' . basename($file, '.php');
		foreach (get_class_methods($class) as $method) {
			if (!str_starts_with($method, 'test')) {
				continue;
			}
			$t = new $class();
			try {
				$t->$method();
				if ($t->expected !== null) {
					throw new \PHPUnit\Framework\AssertionFailed("expected {$t->expected}");
				}
				$passed++;
			} catch (\Throwable $e) {
				if ($t->expected !== null && $e instanceof $t->expected) {
					$passed++;
					continue;
				}
				$failed++;
				echo "FAIL $class::$method: " . $e->getMessage() . "\n";
			}
		}
	}
	echo "$passed passed, $failed failed\n";
	exit($failed === 0 ? 0 : 1);
}
