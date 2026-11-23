<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Migration;

use OCP\Migration\IOutput;
use OCP\Migration\IRepairStep;

/** Uninstall: removes our entries from the MIME config files (files keep their mimetype id). */
class UnregisterMimeType implements IRepairStep {
	public function getName(): string {
		return 'Unregister the .ocanvas MIME type';
	}

	public function run(IOutput $output): void {
		$dir = \OC::$configDir;
		RegisterMimeType::merge($dir . 'mimetypemapping.json', RegisterMimeType::MAPPING, true);
		RegisterMimeType::merge($dir . 'mimetypealiases.json', RegisterMimeType::ALIASES, true);
	}
}
