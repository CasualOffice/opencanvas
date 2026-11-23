<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Wopi;

/**
 * The bytes of a new `.ocanvas` file. `blank` is an empty file: OpenCanvas opens an empty body as
 * a new canvas and shows its own start screen (blank, database, board, templates, import).
 * `database` and `whiteboard` are a zip with only `document.json` (docs/04 §2.3; OpenCanvas reads
 * `document.json` when there is no `ydoc.bin`), holding one empty database or board block.
 * No Nextcloud dependency.
 */
final class StarterFiles {
	public const KINDS = ['blank', 'database', 'whiteboard'];

	public static function bytes(string $kind, string $title): string {
		return match ($kind) {
			'blank' => '',
			'database' => self::zip(self::database($title)),
			'whiteboard' => self::zip(self::whiteboard($title)),
			default => throw new \InvalidArgumentException('unknown starter kind'),
		};
	}

	private static function database(string $title): array {
		$db = 'db' . bin2hex(random_bytes(5));
		return [
			'type' => 'doc',
			'content' => [['type' => 'database', 'attrs' => ['dbId' => $db]], ['type' => 'paragraph']],
			'meta' => ['title' => $title, 'icon' => 'database', 'tone' => 'blue', 'template' => 'dbblank'],
			'databases' => [$db => [
				'name' => $title, 'icon' => 'database', 'tone' => 'blue', 'view' => 'table',
				'fields' => [['id' => 'title', 'name' => 'Name', 'type' => 'title', 'options' => null]],
				'order' => [], 'rows' => (object)[], 'notes' => (object)[], 'views' => (object)[],
			]],
			'boards' => (object)[],
			'comments' => (object)[],
		];
	}

	private static function whiteboard(string $title): array {
		$bd = 'bd' . bin2hex(random_bytes(5));
		return [
			'type' => 'doc',
			'content' => [['type' => 'board', 'attrs' => ['boardId' => $bd]], ['type' => 'paragraph']],
			'meta' => ['title' => $title, 'icon' => 'shapes', 'tone' => 'purple', 'template' => 'boardblank'],
			'databases' => (object)[],
			'boards' => [$bd => ['shapes' => (object)[], 'order' => []]],
			'comments' => (object)[],
		];
	}

	private static function zip(array $document): string {
		$tmp = tempnam(sys_get_temp_dir(), 'ocanvas');
		$zip = new \ZipArchive();
		if ($tmp === false || $zip->open($tmp, \ZipArchive::OVERWRITE) !== true) {
			throw new \RuntimeException('cannot create a zip');
		}
		$zip->addFromString('document.json', json_encode($document, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
		$zip->close();
		$bytes = (string)file_get_contents($tmp);
		unlink($tmp);
		return $bytes;
	}
}
