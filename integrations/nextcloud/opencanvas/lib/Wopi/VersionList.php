<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Wopi;

/**
 * Nextcloud file versions → the OpenCanvas version list (docs/30 §3.1, VH-01c). Pure function.
 *
 * Nextcloud side: each `files_versions` version has a revision (its mtime), a size and metadata
 * (`label`, `author`, and ours: `opencanvas_kind`, `opencanvas_restored_from`). The label is the
 * version's name; Nextcloud keeps labelled versions through its automatic and max-age expiry
 * (but not through the low-space fallback, see README.md).
 */
final class VersionList {
	public const META_KIND = 'opencanvas_kind';
	public const META_RESTORED_FROM = 'opencanvas_restored_from';

	/**
	 * @param list<array{revision: int|string, timestamp: int, size: int, metadata: array<string, string|null>}> $versions
	 * @return array{versions: list<array<string, mixed>>}
	 */
	public static function map(array $versions, int $limit = 100): array {
		usort($versions, fn ($a, $b) => $b['timestamp'] <=> $a['timestamp']);
		$out = [];
		foreach (array_slice($versions, 0, max(1, min(100, $limit))) as $v) {
			$m = $v['metadata'];
			$label = trim((string)($m['label'] ?? ''));
			$kind = $m[self::META_KIND] ?? null;
			if (!in_array($kind, ['auto', 'named', 'restore'], true)) {
				$kind = $label !== '' ? 'named' : 'auto';
			}
			$row = [
				'version' => (string)$v['revision'],
				'at' => gmdate('Y-m-d\TH:i:s\Z', $v['timestamp']),
				'authors' => array_values(array_filter([(string)($m['author'] ?? '')])),
				'kind' => $kind,
				'size' => $v['size'],
			];
			if ($label !== '') {
				$row['name'] = mb_substr($label, 0, 120);
			}
			if (($m[self::META_RESTORED_FROM] ?? '') !== '') {
				$row['restoredFrom'] = (string)$m[self::META_RESTORED_FROM];
			}
			$out[] = $row;
		}
		return ['versions' => $out];
	}

	/**
	 * What to write on a version from PutFile headers: `X-COOL-WOPI-IsAutosave: false` plus
	 * `X-OpenCanvas-Commit-Message` (percent-encoded UTF-8) names it (closes G3).
	 *
	 * @return array<string, string> metadata key → value; empty for autosaves
	 */
	public static function labelsFor(string $isAutosave, string $message, string $restoredFrom): array {
		if ($isAutosave !== 'false') {
			return [];
		}
		$name = trim(rawurldecode($message));
		if ($name === '' || !mb_check_encoding($name, 'UTF-8')) {
			return [];
		}
		$name = mb_substr($name, 0, 120);
		$from = trim(rawurldecode($restoredFrom));
		$out = ['label' => $name, self::META_KIND => $from !== '' ? 'restore' : 'named'];
		if ($from !== '') {
			$out[self::META_RESTORED_FROM] = mb_substr($from, 0, 200);
		}
		return $out;
	}
}
