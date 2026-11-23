<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Migration;

use OCA\OpenCanvas\AppInfo\Application;
use OCP\Files\IMimeTypeLoader;
use OCP\Migration\IOutput;
use OCP\Migration\IRepairStep;

/**
 * Teaches Nextcloud the `.ocanvas` extension (install and post-migration repair step), the way
 * the draw.io app does: merge into `config/mimetypemapping.json` and `config/mimetypealiases.json`,
 * then retag existing files. The alias points at a core icon until ours is approved
 * (UI-SCREENS.md); after changing aliases run `occ maintenance:mimetype:update-js`.
 * Uses `\OC::$configDir` (not public API; same as draw.io).
 */
class RegisterMimeType implements IRepairStep {
	public const MAPPING = ['ocanvas' => [Application::MIME]];
	public const ALIASES = [Application::MIME => 'x-office-document'];

	public function __construct(
		private IMimeTypeLoader $mimeTypeLoader,
	) {
	}

	public function getName(): string {
		return 'Register the .ocanvas MIME type';
	}

	public function run(IOutput $output): void {
		$dir = \OC::$configDir;
		self::merge($dir . 'mimetypemapping.json', self::MAPPING);
		self::merge($dir . 'mimetypealiases.json', self::ALIASES);
		$id = $this->mimeTypeLoader->getId(Application::MIME);
		$n = $this->mimeTypeLoader->updateFilecache('ocanvas', $id);
		$output->info("Retagged $n .ocanvas files");
	}

	/** Adds our keys to a JSON object file, keeping everything else. */
	public static function merge(string $path, array $entries, bool $remove = false): void {
		$data = [];
		if (is_file($path)) {
			$data = json_decode((string)file_get_contents($path), true) ?: [];
		}
		foreach ($entries as $k => $v) {
			if ($remove) {
				unset($data[$k]);
			} else {
				$data[$k] = $v;
			}
		}
		if ($data === []) {
			if (is_file($path)) {
				unlink($path);
			}
			return;
		}
		file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
	}
}
