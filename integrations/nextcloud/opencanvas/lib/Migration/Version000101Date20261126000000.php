<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * SRCH-05 (ADR-065): Nextcloud's own index of canvas text, from the `search.json` in each saved
 * `.ocanvas`. One row per file id; who may see a row is decided at search time by Nextcloud's
 * file access (never stored here). OpenCanvas keeps no index; this is the host's.
 */
class Version000101Date20261126000000 extends SimpleMigrationStep {
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		if ($schema->hasTable('opencanvas_search')) {
			return null;
		}
		$t = $schema->createTable('opencanvas_search');
		$t->addColumn('fileid', Types::BIGINT, ['notnull' => true, 'unsigned' => true]);
		$t->addColumn('title', Types::STRING, ['notnull' => false, 'length' => 255]);
		// The lines as JSON ([{b, p, t}], ≤ 5,000) and their folded text for the LIKE prefilter.
		$t->addColumn('lines', Types::TEXT, ['notnull' => false]);
		$t->addColumn('hay', Types::TEXT, ['notnull' => false]);
		$t->addColumn('mtime', Types::BIGINT, ['notnull' => true, 'default' => 0]);
		$t->setPrimaryKey(['fileid']);
		return $schema;
	}
}
