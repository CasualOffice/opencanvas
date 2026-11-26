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
 * TALK-01: meeting canvases (one row per call's temporary canvas; the bytes are in app data) and
 * per-conversation state ("Participants can start a canvas", who leads "Follow me" and where).
 */
class Version000102Date20261127000000 extends SimpleMigrationStep {
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		$changed = false;
		if (!$schema->hasTable('opencanvas_meetings')) {
			$t = $schema->createTable('opencanvas_meetings');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'unsigned' => true]);
			$t->addColumn('room', Types::STRING, ['notnull' => true, 'length' => 64]);
			$t->addColumn('state', Types::STRING, ['notnull' => true, 'length' => 16]);
			$t->addColumn('created_by', Types::STRING, ['notnull' => true, 'length' => 255]);
			$t->addColumn('created_at', Types::BIGINT, ['notnull' => true, 'default' => 0]);
			$t->addColumn('ended_at', Types::BIGINT, ['notnull' => false]);
			$t->addColumn('guests_edit', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
			$t->addColumn('locked', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
			$t->addColumn('moderator_seen', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
			$t->addColumn('saved_file_id', Types::BIGINT, ['notnull' => false]);
			$t->addColumn('decided_by', Types::STRING, ['notnull' => false, 'length' => 255]);
			$t->addColumn('members', Types::TEXT, ['notnull' => false]);
			$t->setPrimaryKey(['id']);
			$t->addIndex(['room'], 'oc_meet_room');
			$t->addIndex(['state', 'ended_at'], 'oc_meet_state');
			$changed = true;
		}
		if (!$schema->hasTable('opencanvas_talk_rooms')) {
			$t = $schema->createTable('opencanvas_talk_rooms');
			$t->addColumn('room', Types::STRING, ['notnull' => true, 'length' => 64]);
			$t->addColumn('start_open', Types::SMALLINT, ['notnull' => true, 'default' => 1]);
			$t->addColumn('follow', Types::TEXT, ['notnull' => false]);
			$t->setPrimaryKey(['room']);
			$changed = true;
		}
		return $changed ? $schema : null;
	}
}
