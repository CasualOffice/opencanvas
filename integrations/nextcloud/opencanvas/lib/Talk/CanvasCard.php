<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Talk;

/**
 * TALK-01 1b / 5c: the card a canvas posted to a Talk conversation shows. The message carries
 * the canvas's full-page link (`/apps/opencanvas/open/{id}?talk=1&by={uid}`); the reference
 * provider turns it into this card for each reader. Posting never grants access: someone who
 * can't open the file sees the title as posted and who shared it, no path, preview or presence.
 * Pure, no Nextcloud dependency.
 */
final class CanvasCard {
	public const RICH_TYPE = 'opencanvas-canvas';
	private const PATTERN = '#/apps/opencanvas/open/(\d+)(?:\?([^\#]*))?(?:\#.*)?$#';

	public static function link(string $openBase, int $fileId, string $by): string {
		return rtrim($openBase, '/') . '/' . $fileId . '?' . http_build_query(['talk' => 1, 'by' => $by]);
	}

	/** @return array{fileId: int, by: string}|null */
	public static function parse(string $url): ?array {
		if (preg_match(self::PATTERN, $url, $m) !== 1) {
			return null;
		}
		parse_str($m[2] ?? '', $q);
		$by = isset($q['by']) && is_string($q['by']) ? $q['by'] : '';
		return ['fileId' => (int)$m[1], 'by' => $by];
	}

	/**
	 * @param string $path the file's path in the reader's Files ('' without access)
	 * @param string $text the canvas's text, first lines first (its search index)
	 */
	public static function build(int $fileId, string $name, string $path, string $text, int $mtime, string $sharer, bool $access): array {
		$title = preg_replace('/\.ocanvas$/i', '', $name) ?? $name;
		if (!$access) {
			return ['fileId' => $fileId, 'title' => $title, 'access' => false, 'sharer' => $sharer];
		}
		$lines = array_values(array_filter(array_map('trim', explode("\n", $text)), static fn ($l) => $l !== ''));
		return [
			'fileId' => $fileId,
			'title' => $title,
			'access' => true,
			'sharer' => $sharer,
			'where' => 'Files' . implode(' / ', array_merge([''], array_filter(explode('/', $path), static fn ($p) => $p !== ''))),
			'preview' => array_map(static fn ($l) => mb_substr($l, 0, 160), array_slice($lines, 0, 2)),
			'mtime' => $mtime,
		];
	}
}
