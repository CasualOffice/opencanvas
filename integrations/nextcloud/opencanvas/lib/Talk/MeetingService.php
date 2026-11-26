<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Talk;

use OCA\OpenCanvas\Wopi\StarterFiles;

/**
 * TALK-01: meeting canvases per call and "Follow me" (docs/prototypes/v04-approved/
 * nextcloud-talk.html 3a-4b). The call's state is read from Talk on every request, so a call that
 * ended is noticed by the next person who looks (and by the ExpireMeetings job): the canvas turns
 * read only, the moderator is asked to save or discard, and after 10 minutes without an answer it
 * is discarded. Every role change is pushed to open editors at once (docs/05 §7 role API).
 */
class MeetingService {
	/** A saved or discarded meeting is still reported this long, for the "Saved to Files" banner. */
	private const RECENT = 3600;

	/** @var \Closure(): int */
	private \Closure $clock;
	/** @var \Closure(int, string, string): void meeting id, actor id, role or "none" */
	private \Closure $push;

	public function __construct(
		private MeetingStore $store,
		private TalkGateway $talk,
		private MeetingFiles $files,
		callable $clock,
		callable $push,
	) {
		$this->clock = \Closure::fromCallable($clock);
		$this->push = \Closure::fromCallable($push);
	}

	/** The person as a participant of the conversation; NOT_FOUND when they aren't in it. */
	public function actor(string $room, string $actorId, string $name = ''): RoomActor {
		$who = $this->talk->whoIs($room, $actorId);
		if ($who === null) {
			throw new TalkException('NOT_FOUND');
		}
		return new RoomActor($actorId, $name !== '' ? $name : $actorId, $who);
	}

	/** Everything the Canvas panel shows for this person. */
	public function state(string $room, RoomActor $a): array {
		$r = $this->room($room);
		$m = $this->store->latest($room);
		if ($m !== null) {
			$this->refresh($m, $r['callActive'], $a);
		}
		$recent = $m !== null && ($m->isOpen() || ($m->endedAt ?? $m->createdAt) >= $this->now() - self::RECENT);
		$canStartSetting = $this->store->participantsCanStart($room);
		return [
			'who' => $a->who,
			'conversation' => $r['name'],
			'callActive' => $r['callActive'],
			'participantsCanStart' => $canStartSetting,
			'canStart' => MeetingPolicy::canStart($a->who, $canStartSetting),
			'meeting' => $recent ? $this->view($m, $a) : null,
			'follow' => $this->store->follow($room),
		];
	}

	/** Starts the call's meeting canvas, or returns the one already running. */
	public function start(string $room, RoomActor $a): Meeting {
		$r = $this->room($room);
		if (!MeetingPolicy::canStart($a->who, $this->store->participantsCanStart($room))) {
			throw new TalkException('FORBIDDEN');
		}
		if (!$r['callActive']) {
			throw new TalkException('NO_CALL');
		}
		$m = $this->store->latest($room);
		if ($m !== null) {
			$this->refresh($m, true, $a);
			if ($m->state === Meeting::ACTIVE) {
				return $m;
			}
		}
		$now = $this->now();
		$m = $this->store->insert(new Meeting(0, $room, Meeting::ACTIVE, $a->id, $now, null, false, false, $a->who === MeetingPolicy::MODERATOR));
		$this->files->create($m->id, StarterFiles::bytes('blank', $r['name'] . ' meeting canvas'));
		return $m;
	}

	/** Records that this person opened it (so role changes reach their editor) and returns their role. */
	public function launched(int $id, RoomActor $a): ?string {
		$m = $this->store->get($id);
		if ($m === null) {
			return null;
		}
		if (($m->members[$a->id] ?? null) !== $a->who || ($a->who === MeetingPolicy::MODERATOR && !$m->moderatorSeen && $m->state === Meeting::ACTIVE)) {
			$m->members[$a->id] = $a->who;
			if ($a->who === MeetingPolicy::MODERATOR && $m->state === Meeting::ACTIVE) {
				$m->moderatorSeen = true;
			}
			$this->store->update($m);
		}
		return MeetingPolicy::role($m, $a->who);
	}

	/** The live role of a participant (WOPI calls), null when they have none. */
	public function roleOf(int $id, string $actorId): ?string {
		$m = $this->store->get($id);
		if ($m === null) {
			return null;
		}
		$who = $this->talk->whoIs($m->room, $actorId);
		return $who === null ? null : MeetingPolicy::role($m, $who);
	}

	public function meeting(int $id): ?Meeting {
		return $this->store->get($id);
	}

	/** The moderator saves (into their Talk folder, posted back to the conversation) or discards. */
	public function decide(string $room, int $id, RoomActor $a, string $action, bool $post): Meeting {
		$m = $this->owned($room, $id);
		$this->refresh($m, $this->room($room)['callActive'], $a);
		if (!$m->isOpen()) {
			throw new TalkException('GONE');
		}
		if (!MeetingPolicy::canSave($m, $a->who)) {
			throw new TalkException('FORBIDDEN');
		}
		if ($action === 'save') {
			$bytes = $this->files->read($m->id);
			if ($bytes === null) {
				throw new TalkException('GONE');
			}
			$name = sprintf('%s meeting canvas %s.ocanvas', $this->room($room)['name'], gmdate('Y-m-d H.i', $m->createdAt));
			$name = str_replace(['/', '\\'], '-', $name);
			$m->savedFileId = $this->files->saveToTalk($a->id, $this->talk->talkFolder($a->id), $name, $bytes);
			if ($post) {
				$this->talk->shareFile($m->savedFileId, $room, $a->id);
			}
			$m->state = Meeting::SAVED;
		} elseif ($action === 'discard') {
			$m->state = Meeting::DISCARDED;
		} else {
			throw new TalkException('BAD_REQUEST');
		}
		$m->decidedBy = $a->id;
		$m->endedAt ??= $this->now();
		$this->close($m);
		return $m;
	}

	/** Moderator tools: guests can edit, lock canvas. */
	public function options(string $room, int $id, RoomActor $a, array $opts): Meeting {
		$m = $this->owned($room, $id);
		$this->refresh($m, $this->room($room)['callActive'], $a);
		if (!MeetingPolicy::canModerate($m, $a->who)) {
			throw new TalkException('FORBIDDEN');
		}
		if (array_key_exists('guestsCanEdit', $opts)) {
			$m->guestsCanEdit = (bool)$opts['guestsCanEdit'];
		}
		if (array_key_exists('locked', $opts)) {
			$m->locked = (bool)$opts['locked'];
		}
		$this->store->update($m);
		$this->pushRoles($m);
		return $m;
	}

	/** "Participants can start a canvas" (moderators only). */
	public function setParticipantsCanStart(string $room, RoomActor $a, bool $on): void {
		if ($a->who !== MeetingPolicy::MODERATOR) {
			throw new TalkException('FORBIDDEN');
		}
		$this->store->setParticipantsCanStart($room, $on);
	}

	/**
	 * "Follow me": a moderator leads on a canvas (`m:<id>` for the meeting canvas, `f:<fileId>`
	 * for a shared file); everyone with the panel open scrolls with them. Off: by them or any
	 * moderator.
	 */
	public function follow(string $room, RoomActor $a, string $canvas, bool $on): void {
		if ($a->who !== MeetingPolicy::MODERATOR) {
			throw new TalkException('FORBIDDEN');
		}
		if ($on && preg_match('/^[mf]:\d+$/', $canvas) !== 1) {
			throw new TalkException('BAD_REQUEST');
		}
		$this->store->setFollow($room, $on ? ['by' => $a->id, 'name' => $a->name, 'canvas' => $canvas, 'block' => null] : null);
	}

	/** Where the leader is (the top block in their view); ignored from anyone else. */
	public function followView(string $room, RoomActor $a, string $block): void {
		$f = $this->store->follow($room);
		if ($f === null || $f['by'] !== $a->id || preg_match('/^[A-Za-z0-9_-]{1,64}$/', $block) !== 1) {
			return;
		}
		$f['block'] = $block;
		$this->store->setFollow($room, $f);
	}

	/** The background job: discards ended meetings nobody decided on in time; returns how many. */
	public function expire(): int {
		$n = 0;
		foreach ($this->store->pending($this->now() - MeetingPolicy::DECISION_SECONDS) as $m) {
			if (MeetingPolicy::settle($m, $this->now())) {
				$this->close($m);
				$n++;
			}
		}
		return $n;
	}

	/** Reads the meeting's bytes for WOPI GetFile. */
	public function read(int $id): ?string {
		return $this->files->read($id);
	}

	/** WOPI PutFile: only while someone may still edit it. */
	public function write(int $id, string $bytes): bool {
		$m = $this->store->get($id);
		if ($m === null || $m->state !== Meeting::ACTIVE) {
			return false;
		}
		$this->files->write($id, $bytes);
		return true;
	}

	private function view(Meeting $m, RoomActor $a): array {
		return [
			'id' => $m->id,
			'state' => $m->state,
			'role' => MeetingPolicy::role($m, $a->who),
			'canSave' => MeetingPolicy::canSave($m, $a->who),
			'canDownload' => MeetingPolicy::canDownload($a->who),
			'canModerate' => MeetingPolicy::canModerate($m, $a->who),
			'guestsCanEdit' => $m->guestsCanEdit,
			'locked' => $m->locked,
			'startedAt' => $m->createdAt,
			'endedAt' => $m->endedAt,
			'discardAt' => $m->state === Meeting::ENDED && $m->endedAt !== null ? $m->endedAt + MeetingPolicy::DECISION_SECONDS : null,
			'savedFileId' => $m->state === Meeting::SAVED ? $m->savedFileId : null,
		];
	}

	/** Notices the end of the call, the moderator's presence and the 10-minute window. */
	private function refresh(Meeting $m, bool $callActive, RoomActor $a): void {
		$before = [$m->state, $m->moderatorSeen];
		if ($m->state === Meeting::ACTIVE && $a->who === MeetingPolicy::MODERATOR) {
			$m->moderatorSeen = true;
		}
		if ($m->state === Meeting::ACTIVE && !$callActive) {
			MeetingPolicy::callEnded($m, $this->now());
		}
		MeetingPolicy::settle($m, $this->now());
		if ([$m->state, $m->moderatorSeen] === $before) {
			return;
		}
		if ($m->state === $before[0]) {
			$this->store->update($m);
			return;
		}
		if ($m->isOpen()) {
			$this->store->update($m);
			$this->pushRoles($m);
		} else {
			$this->close($m);
		}
	}

	/** Saved or discarded: the temporary bytes go, editors close, Follow me on it stops. */
	private function close(Meeting $m): void {
		$this->store->update($m);
		$this->files->delete($m->id);
		$this->pushRoles($m);
		$f = $this->store->follow($m->room);
		if ($f !== null && $f['canvas'] === 'm:' . $m->id) {
			$this->store->setFollow($m->room, null);
		}
	}

	private function pushRoles(Meeting $m): void {
		foreach ($m->members as $id => $who) {
			($this->push)($m->id, (string)$id, MeetingPolicy::role($m, $who) ?? 'none');
		}
	}

	private function owned(string $room, int $id): Meeting {
		$m = $this->store->get($id);
		if ($m === null || $m->room !== $room) {
			throw new TalkException('NOT_FOUND');
		}
		return $m;
	}

	/** @return array{name: string, callActive: bool} */
	private function room(string $room): array {
		$r = $this->talk->room($room);
		if ($r === null) {
			throw new TalkException('NOT_FOUND');
		}
		return $r;
	}

	private function now(): int {
		return ($this->clock)();
	}
}
