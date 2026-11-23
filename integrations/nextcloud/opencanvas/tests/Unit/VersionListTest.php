<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Tests\Unit;

use OCA\OpenCanvas\Wopi\VersionList as V;
use PHPUnit\Framework\TestCase;

final class VersionListTest extends TestCase {
	public function testMapsNextcloudVersionsNewestFirstWithLabelsAndAuthors(): void {
		$out = V::map([
			['revision' => 1764000000, 'timestamp' => 1764000000, 'size' => 10, 'metadata' => ['author' => 'lea']],
			['revision' => 1764000600, 'timestamp' => 1764000600, 'size' => 12, 'metadata' => ['author' => 'jonas', 'label' => ' Board review ready ']],
			['revision' => 1764000900, 'timestamp' => 1764000900, 'size' => 13, 'metadata' => [
				'author' => 'lea', 'label' => 'Restored from Nov 21, 10:14', 'opencanvas_kind' => 'restore', 'opencanvas_restored_from' => '1764000000',
			]],
		]);
		$v = $out['versions'];
		$this->assertSame(3, count($v));
		$this->assertSame('1764000900', $v[0]['version']);
		$this->assertSame('restore', $v[0]['kind']);
		$this->assertSame('1764000000', $v[0]['restoredFrom']);
		$this->assertSame('named', $v[1]['kind']);
		$this->assertSame('Board review ready', $v[1]['name']);
		$this->assertSame(['jonas'], $v[1]['authors']);
		$this->assertSame('auto', $v[2]['kind']);
		$this->assertFalse(isset($v[2]['name']));
		$this->assertSame('2025-11-24T16:00:00Z', $v[2]['at']);
	}

	public function testOnlyNamedSavesGetALabel(): void {
		$this->assertSame([], V::labelsFor('true', 'Ignored', ''));
		$this->assertSame([], V::labelsFor('false', '', ''));
		$this->assertSame(
			['label' => 'Board review — ready ✓', 'opencanvas_kind' => 'named'],
			V::labelsFor('false', 'Board%20review%20%E2%80%94%20ready%20%E2%9C%93', ''),
		);
		$this->assertSame(
			['label' => 'Restored from Nov 21', 'opencanvas_kind' => 'restore', 'opencanvas_restored_from' => '17'],
			V::labelsFor('false', 'Restored%20from%20Nov%2021', '17'),
		);
		$this->assertSame(120, mb_strlen(V::labelsFor('false', str_repeat('a', 300), '')['label']));
	}
}
