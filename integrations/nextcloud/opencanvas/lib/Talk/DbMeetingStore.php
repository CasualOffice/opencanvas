<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Talk;

use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/** MeetingStore in `oc_opencanvas_meetings` and `oc_opencanvas_talk_rooms` (migration 000102). */
class DbMeetingStore implements MeetingStore {
	private const T = 'opencanvas_meetings';
	private const R = 'opencanvas_talk_rooms';

	public function __construct(
		private IDBConnection $db,
	) {
	}

	public function latest(string $room): ?Meeting {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from(self::T)->where($qb->expr()->eq('room', $qb->createNamedParameter($room)))->orderBy('id', 'DESC')->setMaxResults(1);
		return $this->one($qb);
	}

	public function get(int $id): ?Meeting {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from(self::T)->where($qb->expr()->eq('id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)));
		return $this->one($qb);
	}

	public function insert(Meeting $m): Meeting {
		$qb = $this->db->getQueryBuilder();
		$qb->insert(self::T)->values(array_map(static fn ($v) => $qb->createNamedParameter($v), $this->row($m)))->executeStatement();
		$m->id = $qb->getLastInsertId();
		return $m;
	}

	public function update(Meeting $m): void {
		$qb = $this->db->getQueryBuilder();
		$qb->update(self::T);
		foreach ($this->row($m) as $k => $v) {
			$qb->set($k, $qb->createNamedParameter($v));
		}
		$qb->where($qb->expr()->eq('id', $qb->createNamedParameter($m->id, IQueryBuilder::PARAM_INT)))->executeStatement();
	}

	public function pending(int $before): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from(self::T)
			->where($qb->expr()->eq('state', $qb->createNamedParameter(Meeting::ENDED)))
			->andWhere($qb->expr()->lte('ended_at', $qb->createNamedParameter($before, IQueryBuilder::PARAM_INT)));
		$res = $qb->executeQuery();
		$out = [];
		while (($r = $res->fetch()) !== false) {
			$out[] = $this->meeting($r);
		}
		$res->closeCursor();
		return $out;
	}

	public function participantsCanStart(string $room): bool {
		$r = $this->roomRow($room);
		return $r === null || (int)$r['start_open'] === 1;
	}

	public function setParticipantsCanStart(string $room, bool $on): void {
		$this->setRoom($room, ['start_open' => $on ? 1 : 0]);
	}

	public function follow(string $room): ?array {
		$r = $this->roomRow($room);
		$f = $r === null || $r['follow'] === null ? null : json_decode((string)$r['follow'], true);
		return is_array($f) ? $f : null;
	}

	public function setFollow(string $room, ?array $follow): void {
		$this->setRoom($room, ['follow' => $follow === null ? null : json_encode($follow)]);
	}

	private function roomRow(string $room): ?array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from(self::R)->where($qb->expr()->eq('room', $qb->createNamedParameter($room)));
		$res = $qb->executeQuery();
		$r = $res->fetch();
		$res->closeCursor();
		return $r === false ? null : $r;
	}

	private function setRoom(string $room, array $vals): void {
		$qb = $this->db->getQueryBuilder();
		if ($this->roomRow($room) === null) {
			$qb->insert(self::R)->values(array_map(static fn ($v) => $qb->createNamedParameter($v), ['room' => $room] + $vals))->executeStatement();
			return;
		}
		$qb->update(self::R);
		foreach ($vals as $k => $v) {
			$qb->set($k, $qb->createNamedParameter($v));
		}
		$qb->where($qb->expr()->eq('room', $qb->createNamedParameter($room)))->executeStatement();
	}

	private function one(IQueryBuilder $qb): ?Meeting {
		$res = $qb->executeQuery();
		$r = $res->fetch();
		$res->closeCursor();
		return $r === false ? null : $this->meeting($r);
	}

	private function row(Meeting $m): array {
		return [
			'room' => $m->room,
			'state' => $m->state,
			'created_by' => $m->createdBy,
			'created_at' => $m->createdAt,
			'ended_at' => $m->endedAt,
			'guests_edit' => $m->guestsCanEdit ? 1 : 0,
			'locked' => $m->locked ? 1 : 0,
			'moderator_seen' => $m->moderatorSeen ? 1 : 0,
			'saved_file_id' => $m->savedFileId,
			'decided_by' => $m->decidedBy,
			'members' => json_encode($m->members, JSON_FORCE_OBJECT),
		];
	}

	private function meeting(array $r): Meeting {
		$members = json_decode((string)($r['members'] ?? '{}'), true);
		return new Meeting(
			(int)$r['id'],
			(string)$r['room'],
			(string)$r['state'],
			(string)$r['created_by'],
			(int)$r['created_at'],
			$r['ended_at'] === null ? null : (int)$r['ended_at'],
			(int)$r['guests_edit'] === 1,
			(int)$r['locked'] === 1,
			(int)$r['moderator_seen'] === 1,
			$r['saved_file_id'] === null ? null : (int)$r['saved_file_id'],
			$r['decided_by'] === null ? null : (string)$r['decided_by'],
			is_array($members) ? $members : [],
		);
	}
}
