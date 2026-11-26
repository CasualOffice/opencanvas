<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Tests\Unit;

use OCA\OpenCanvas\Search\SearchText as S;
use PHPUnit\Framework\TestCase;

/** SRCH-05: indexing search.json from a saved .ocanvas and matching unified search queries. */
final class SearchTextTest extends TestCase {
	private const SJ = [
		'v' => 1, 'title' => 'Sprint 42 planning', 'lang' => 'en',
		'blocks' => [
			['id' => 'b_9f2', 'type' => 'heading', 'path' => ['Release 4.2'], 'text' => 'Release 4.2'],
			['id' => 'b_a10', 'type' => 'todo', 'path' => ['Release 4.2'], 'text' => "SSO set-up\n docs updated", 'done' => false],
			['id' => 'bad id!', 'type' => 'paragraph', 'path' => [], 'text' => 'Résumé of the retro'],
		],
		'databases' => [['id' => 'db_1', 'title' => 'Sprint 42 backlog', 'rows' => [['id' => 'r_1', 'text' => 'Fix CSV export timeout · Marco Bianchi · In review']]]],
		'boards' => [['id' => 'bd_1', 'text' => 'Hero copy is too long on phones']],
		'live' => [['blockId' => 'b_c3', 'fileId' => 'doc_9120', 'title' => 'Release 4.2 checklist']],
		'truncated' => false,
	];

	private static function zip(array $files): string {
		$path = tempnam(sys_get_temp_dir(), 'ocz');
		$z = new \ZipArchive();
		$z->open($path, \ZipArchive::OVERWRITE);
		foreach ($files as $name => $body) {
			$z->addFromString($name, $body);
		}
		$z->close();
		return $path;
	}

	public function testReadsSearchJsonFromASavedCanvas(): void {
		$path = self::zip(['mimetype' => 'application/vnd.opencanvas+zip', 'document.json' => '{}', 'search.json' => json_encode(self::SJ)]);
		try {
			$e = S::fromZipFile($path);
		} finally {
			unlink($path);
		}
		$this->assertNotNull($e);
		$this->assertSame('Sprint 42 planning', $e['title']);
		$this->assertSame(['b' => 'b_a10', 'p' => 'Release 4.2', 't' => 'SSO set-up docs updated'], $e['lines'][1]);
		// A block id that is not one is dropped, the text kept; databases, boards, live titles.
		$this->assertSame(null, $e['lines'][2]['b']);
		$this->assertSame('Sprint 42 backlog', $e['lines'][3]['p']);
		$this->assertSame('Board', $e['lines'][4]['p']);
		$this->assertSame(['b' => 'b_c3', 'p' => 'Live block', 't' => 'Release 4.2 checklist'], $e['lines'][5]);
	}

	public function testAnOlderCanvasOrAnotherZipIsNotIndexed(): void {
		$old = self::zip(['document.json' => '{}']);
		$v2 = self::zip(['search.json' => json_encode(['v' => 2, 'title' => 'x'])]);
		$notZip = tempnam(sys_get_temp_dir(), 'ocz');
		file_put_contents($notZip, 'plain text');
		try {
			$this->assertNull(S::fromZipFile($old));
			$this->assertNull(S::fromZipFile($v2));
			$this->assertNull(S::fromZipFile($notZip));
			$this->assertNull(S::fromJson('{"v":1,'));
		} finally {
			array_map('unlink', [$old, $v2, $notZip]);
		}
	}

	public function testMatchesEveryWordWithTheBlockToOpen(): void {
		$e = S::fromJson(json_encode(self::SJ));
		$m = S::matches($e, 'sso docs');
		$this->assertSame(1, count($m));
		$this->assertSame('b_a10', $m[0]['blockId']);
		$this->assertSame('Release 4.2', $m[0]['path']);
		$this->assertSame('SSO set-up docs updated', $m[0]['snippet']);
		// Words may come from the heading trail; case and accents do not matter.
		$this->assertSame('b_a10', S::matches($e, 'release SSO')[0]['blockId']);
		$this->assertSame('Résumé of the retro', S::matches($e, 'RESUME')[0]['snippet']);
		$this->assertSame('Sprint 42 backlog', S::matches($e, 'csv marco')[0]['path']);
		$this->assertSame([], S::matches($e, 'kubernetes'));
		$this->assertSame([], S::matches($e, '   '));
		// The title alone: the canvas, opened at the top.
		$t = S::matches(['title' => 'Quarterly review', 'lines' => [['b' => 'b_1', 'p' => '', 't' => 'Agenda']]], 'quarterly');
		$this->assertSame([['blockId' => null, 'path' => '', 'snippet' => 'Agenda']], $t);
	}

	public function testLimitsAndSnippets(): void {
		$lines = [];
		for ($i = 0; $i < 6000; $i++) {
			$lines[] = ['id' => "b_$i", 'type' => 'paragraph', 'path' => [], 'text' => "line $i"];
		}
		$e = S::fromJson(json_encode(['v' => 1, 'title' => 'Big', 'blocks' => $lines]));
		$this->assertSame(S::MAX_LINES, count($e['lines']));
		$this->assertSame(3, count(S::matches($e, 'line')));
		$long = str_repeat('alpha ', 100) . 'needle ' . str_repeat('omega ', 100);
		$s = S::snippet($long, ['needle']);
		$this->assertStringContainsString('needle', $s);
		$this->assertMatchesRegularExpression('/^….*…$/u', $s);
		$this->assertSame('needle', S::longestWord('a needle in'));
		$this->assertStringContainsString("release 4.2 sso set-up docs updated", S::haystack(S::fromJson(json_encode(self::SJ))));
		$this->assertNull(S::fromJson(str_repeat(' ', S::MAX_JSON + 1)));
	}
}
