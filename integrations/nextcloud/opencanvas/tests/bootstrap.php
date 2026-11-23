<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Unit tests cover the framework-free classes (lib/Wopi); no Nextcloud needed.
spl_autoload_register(static function (string $class): void {
	$prefix = 'OCA\\OpenCanvas\\';
	if (str_starts_with($class, $prefix)) {
		$path = __DIR__ . '/../lib/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
		if (is_file($path)) {
			require $path;
		}
	}
});
