<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Search;

/**
 * SRCH-05 (ADR-065, docs/34 §4.3): the searchable text of a canvas, from the `search.json` that
 * OpenCanvas puts in every saved `.ocanvas`, and matching a query against it. Framework-free
 * (unit-tested without Nextcloud); the index table, the save listener and the unified search
 * provider are the Nextcloud glue around it.
 *
 * search.json v1: {v, title, blocks: [{id, type, path: [...], text}], databases: [{title,
 * rows: [{id, text}]}], boards: [{text}], live: [{blockId, fileId, title}], truncated}.
 */
final class SearchText {
	/** search.json is at most 2 MB (OpenCanvas truncates it); anything larger is not ours. */
	public const MAX_JSON = 2 * 1024 * 1024;
	/** Lines kept per canvas in the index (a canvas past it is searched in its first lines). */
	public const MAX_LINES = 5000;
	public const MAX_LINE = 2000;

	/**
	 * The index entry of a `.ocanvas` at `$path`: `['title' => string, 'lines' => list<array{b:
	 * ?string, p: string, t: string}>]`, or null when it is not a canvas with a search.json v1
	 * (an older file, or not a zip): such a file is simply not indexed until its next save.
	 */
	public static function fromZipFile(string $path): ?array {
		if (!class_exists(\ZipArchive::class)) {
			return null;
		}
		$zip = new \ZipArchive();
		if ($zip->open($path, \ZipArchive::RDONLY) !== true) {
			return null;
		}
		try {
			$stat = $zip->statName('search.json');
			if ($stat === false || $stat['size'] > self::MAX_JSON) {
				return null;
			}
			$json = $zip->getFromName('search.json');
		} finally {
			$zip->close();
		}
		return $json === false ? null : self::fromJson($json);
	}

	/** The index entry of a search.json document (see fromZipFile). */
	public static function fromJson(string $json): ?array {
		if (strlen($json) > self::MAX_JSON) {
			return null;
		}
		$sj = json_decode($json, true, 64);
		if (!is_array($sj) || ($sj['v'] ?? null) !== 1) {
			return null;
		}
		$lines = [];
		$add = static function (?string $block, string $trail, mixed $text) use (&$lines): void {
			if (!is_string($text) || count($lines) >= self::MAX_LINES) {
				return;
			}
			$t = trim(preg_replace('/\s+/u', ' ', $text) ?? '');
			if ($t === '') {
				return;
			}
			$lines[] = ['b' => $block, 'p' => self::clip($trail, 200), 't' => self::clip($t, self::MAX_LINE)];
		};
		foreach (self::listOf($sj['blocks'] ?? null) as $b) {
			$path = is_array($b['path'] ?? null) ? array_values(array_filter($b['path'], 'is_string')) : [];
			$id = is_string($b['id'] ?? null) && preg_match('/^[A-Za-z0-9_-]{1,64}$/', $b['id']) ? $b['id'] : null;
			$add($id, implode(' › ', $path), $b['text'] ?? null);
		}
		foreach (self::listOf($sj['databases'] ?? null) as $d) {
			$title = is_string($d['title'] ?? null) ? $d['title'] : 'Database';
			foreach (self::listOf($d['rows'] ?? null) as $r) {
				$add(null, $title, $r['text'] ?? null);
			}
		}
		foreach (self::listOf($sj['boards'] ?? null) as $bd) {
			foreach (is_array($bd['text'] ?? null) ? $bd['text'] : [$bd['text'] ?? null] as $t) {
				$add(null, 'Board', $t);
			}
		}
		// Live blocks by title only: their text is in their own file's search.json.
		foreach (self::listOf($sj['live'] ?? null) as $l) {
			$id = is_string($l['blockId'] ?? null) && preg_match('/^[A-Za-z0-9_-]{1,64}$/', $l['blockId']) ? $l['blockId'] : null;
			$add($id, 'Live block', $l['title'] ?? null);
		}
		$title = is_string($sj['title'] ?? null) ? self::clip(trim($sj['title']), 255) : '';
		return ['title' => $title, 'lines' => $lines];
	}

	/** Lower case without accents, so "Résumé" finds "resume". */
	public static function fold(string $s): string {
		if (class_exists(\Normalizer::class)) {
			$n = \Normalizer::normalize($s, \Normalizer::FORM_D);
			if (is_string($n)) {
				$s = preg_replace('/\p{Mn}+/u', '', $n) ?? $s;
			}
		}
		return mb_strtolower($s, 'UTF-8');
	}

	/** @return list<string> the query's words, folded. */
	public static function words(string $query): array {
		$w = preg_split('/\s+/u', trim(self::fold($query)), -1, PREG_SPLIT_NO_EMPTY);
		return array_slice(array_values(array_unique($w ?: [])), 0, 10);
	}

	/**
	 * The lines of `$entry` that hold every word of `$query` (in the title, the heading trail or
	 * the text), best first, at most `$max`: `list<array{blockId: ?string, path: string,
	 * snippet: string}>`. A canvas whose title matches and no line does gives its first line.
	 */
	public static function matches(array $entry, string $query, int $max = 3): array {
		$words = self::words($query);
		if (!$words) {
			return [];
		}
		$title = self::fold((string)($entry['title'] ?? ''));
		$hits = [];
		foreach ($entry['lines'] ?? [] as $i => $l) {
			$t = (string)($l['t'] ?? '');
			$p = (string)($l['p'] ?? '');
			$ft = self::fold($t);
			$line = self::fold($p) . ' ' . $ft;
			$all = true;
			$inText = 0;
			$inLine = 0;
			foreach ($words as $w) {
				$here = str_contains($line, $w);
				if (!$here && !str_contains($title, $w)) {
					$all = false;
					break;
				}
				$inLine += $here ? 1 : 0;
				$inText += str_contains($ft, $w) ? 1 : 0;
			}
			// A word may come from the canvas title, but the line must hold one itself.
			if ($all && $inLine > 0) {
				$hits[] = ['score' => $inText * 10000 - $i, 'blockId' => $l['b'] ?? null, 'path' => $p, 'snippet' => self::snippet($t, $words)];
			}
		}
		usort($hits, static fn ($a, $b) => $b['score'] <=> $a['score']);
		$out = array_map(static fn ($h) => ['blockId' => $h['blockId'], 'path' => $h['path'], 'snippet' => $h['snippet']], array_slice($hits, 0, max(1, $max)));
		if (!$out && $title !== '' && array_reduce($words, static fn ($ok, $w) => $ok && str_contains($title, $w), true)) {
			$first = ($entry['lines'] ?? [])[0] ?? null;
			$out[] = ['blockId' => null, 'path' => '', 'snippet' => $first ? self::clip((string)$first['t'], 160) : ''];
		}
		return $out;
	}

	/** About 160 characters of `$text` around the first word found, plain text. */
	public static function snippet(string $text, array $words, int $len = 160): string {
		if (mb_strlen($text) <= $len) {
			return $text;
		}
		$folded = self::fold($text);
		$at = 0;
		foreach ($words as $w) {
			$p = mb_strpos($folded, $w);
			if ($p !== false) {
				$at = $p;
				break;
			}
		}
		$start = max(0, $at - intdiv($len, 3));
		$s = mb_substr($text, $start, $len);
		return ($start > 0 ? '…' : '') . $s . ($start + $len < mb_strlen($text) ? '…' : '');
	}

	/** The words worth a database prefilter (`LIKE`): the longest one. */
	public static function longestWord(string $query): string {
		$best = '';
		foreach (self::words($query) as $w) {
			if (mb_strlen($w) > mb_strlen($best)) {
				$best = $w;
			}
		}
		return $best;
	}

	/** The text the index table keeps for prefiltering: title, trails and lines, folded. */
	public static function haystack(array $entry): string {
		$parts = [self::fold((string)($entry['title'] ?? ''))];
		foreach ($entry['lines'] ?? [] as $l) {
			$parts[] = self::fold($l['p'] . ' ' . $l['t']);
		}
		return implode("\n", $parts);
	}

	private static function listOf(mixed $v): array {
		return is_array($v) && array_is_list($v) ? array_filter($v, 'is_array') : [];
	}

	private static function clip(string $s, int $n): string {
		return mb_strlen($s) > $n ? mb_substr($s, 0, $n) : $s;
	}
}
