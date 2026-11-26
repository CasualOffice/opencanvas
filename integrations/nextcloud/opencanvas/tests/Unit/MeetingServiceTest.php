<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Tests\Unit;

use OCA\OpenCanvas\Talk\Meeting;
use OCA\OpenCanvas\Talk\MeetingFiles;
use OCA\OpenCanvas\Talk\MeetingPolicy as P;
use OCA\OpenCanvas\Talk\MeetingService;
use OCA\OpenCanvas\Talk\MeetingStore;
use OCA\OpenCanvas\Talk\RoomActor;
use OCA\OpenCanvas\Talk\TalkGateway;
use OCA\OpenCanvas\Talk\TalkException;
use PHPUnit\Framework\TestCase;

final class FakeStore implements MeetingStore {
	/** @var array<int, Meeting> */
	public array $rows = [];
	public array $start = [];
	public array $follow = [];
	public function latest(string $room): ?Meeting {
		$found = null;
		foreach ($this->rows as $m) {
			if ($m->room === $room) {
				$found = $m;
			}
		}
		return $found === null ? null : clone $found;
	}
	public function get(int $id): ?Meeting {
		return isset($this->rows[$id]) ? clone $this->rows[$id] : null;
	}
	public function insert(Meeting $m): Meeting {
		$m->id = count($this->rows) + 1;
		$this->rows[$m->id] = clone $m;
		return $m;
	}
	public function update(Meeting $m): void {
		$this->rows[$m->id] = clone $m;
	}
	public function pending(int $before): array {
		return array_values(array_filter($this->rows, fn (Meeting $m) => $m->state === Meeting::ENDED && $m->endedAt <= $before));
	}
	public function participantsCanStart(string $room): bool {
		return $this->start[$room] ?? true;
	}
	public function setParticipantsCanStart(string $room, bool $on): void {
		$this->start[$room] = $on;
	}
	public function follow(string $room): ?array {
		return $this->follow[$room] ?? null;
	}
	public function setFollow(string $room, ?array $f): void {
		$this->follow[$room] = $f;
	}
}

final class FakeTalk implements TalkGateway {
	public bool $call = true;
	/** @var array<string, string> actor id => who */
	public array $people = ['priya' => P::MODERATOR, 'jonas' => P::USER, 'guest-k' => P::GUEST];
	public array $shared = [];
	public function room(string $room): ?array {
		return $room === 'room1' ? ['name' => 'Q1 launch team', 'callActive' => $this->call] : null;
	}
	public function whoIs(string $room, string $actorId): ?string {
		return $room === 'room1' ? ($this->people[$actorId] ?? null) : null;
	}
	public function shareFile(int $fileId, string $room, string $userId): void {
		$this->shared[] = [$fileId, $room, $userId];
	}
	public function talkFolder(string $userId): string {
		return '/Talk';
	}
}

final class FakeFiles implements MeetingFiles {
	public array $blobs = [];
	public array $saved = [];
	public function create(int $id, string $bytes): void {
		$this->blobs[$id] = $bytes;
	}
	public function read(int $id): ?string {
		return $this->blobs[$id] ?? null;
	}
	public function write(int $id, string $bytes): void {
		$this->blobs[$id] = $bytes;
	}
	public function delete(int $id): void {
		unset($this->blobs[$id]);
	}
	public function saveToTalk(string $userId, string $folder, string $name, string $bytes): int {
		$this->saved[] = [$userId, $folder, $name, $bytes];
		return 4242;
	}
}

/** TALK-01: the meeting canvas's life (3a start, 3b during, 3c/3d end, 4a moderator tools). */
class MeetingServiceTest extends TestCase {
	private FakeStore $store;
	private FakeTalk $talk;
	private FakeFiles $files;
	private int $now = 1000;
	private array $pushed = [];

	private function svc(): MeetingService {
		$this->store ??= new FakeStore();
		$this->talk ??= new FakeTalk();
		$this->files ??= new FakeFiles();
		return new MeetingService($this->store, $this->talk, $this->files, fn () => $this->now, function (int $id, string $actor, string $role): void {
			$this->pushed[] = [$id, $actor, $role];
		});
	}
	private function who(string $id): RoomActor {
		return new RoomActor($id, ucfirst($id), $this->talk->people[$id] ?? P::USER);
	}

	public function testOnlyPeopleInTheConversationSeeIt(): void {
		$s = $this->svc();
		$this->expectException(TalkException::class);
		$s->actor('room1', 'stranger');
	}

	public function testParticipantStartsAMeetingCanvasAndEveryoneJoinsTheSameOne(): void {
		$s = $this->svc();
		$m = $s->start('room1', $this->who('jonas'));
		$this->assertSame(Meeting::ACTIVE, $m->state);
		$this->assertNotNull($this->files->read($m->id));
		$this->assertSame($m->id, $s->start('room1', $this->who('priya'))->id);
		$st = $s->state('room1', $this->who('jonas'));
		$this->assertSame('edit', $st['meeting']['role']);
		$this->assertFalse($st['meeting']['canSave']);
	}

	public function testStartingNeedsACallAndPermission(): void {
		$s = $this->svc();
		$this->store->setParticipantsCanStart('room1', false);
		try {
			$s->start('room1', $this->who('jonas'));
			$this->assertTrue(false, 'participant started with the setting off');
		} catch (TalkException $e) {
			$this->assertSame('FORBIDDEN', $e->getMessage());
		}
		$this->talk->call = false;
		try {
			$s->start('room1', $this->who('priya'));
			$this->assertTrue(false, 'started without a call');
		} catch (TalkException $e) {
			$this->assertSame('NO_CALL', $e->getMessage());
		}
	}

	public function testCallEndsModeratorWasThereEveryoneReadOnlyThenSaveGoesToTalkFolderAndIsPosted(): void {
		$s = $this->svc();
		$m = $s->start('room1', $this->who('jonas'));
		$s->launched($m->id, $this->who('jonas'));
		$s->state('room1', $this->who('priya')); // the moderator was present
		$this->talk->call = false;
		$this->now = 2000;
		$st = $s->state('room1', $this->who('jonas'));
		$this->assertSame(Meeting::ENDED, $st['meeting']['state']);
		$this->assertSame('view', $st['meeting']['role']);
		$this->assertSame(2000 + 600, $st['meeting']['discardAt']);
		$this->assertTrue(in_array([$m->id, 'jonas', 'view'], $this->pushed, true), 'open editors switched to read only');
		try {
			$s->decide('room1', $m->id, $this->who('jonas'), 'save', true);
			$this->assertTrue(false, 'a participant saved');
		} catch (TalkException $e) {
			$this->assertSame('FORBIDDEN', $e->getMessage());
		}
		$done = $s->decide('room1', $m->id, $this->who('priya'), 'save', true);
		$this->assertSame(Meeting::SAVED, $done->state);
		$this->assertSame(4242, $done->savedFileId);
		$this->assertSame('/Talk', $this->files->saved[0][1]);
		$this->assertMatchesRegularExpression('/^Q1 launch team meeting canvas .*\.ocanvas$/', $this->files->saved[0][2]);
		$this->assertSame([[4242, 'room1', 'priya']], $this->talk->shared);
		$this->assertNull($this->files->read($m->id), 'the temporary canvas is gone');
		$this->assertTrue(in_array([$m->id, 'jonas', 'none'], $this->pushed, true));
	}

	public function testNoModeratorPresentDiscardsAtOnce(): void {
		$s = $this->svc();
		$m = $s->start('room1', $this->who('jonas'));
		$this->talk->call = false;
		$this->assertSame(Meeting::DISCARDED, $s->state('room1', $this->who('jonas'))['meeting']['state']);
		$this->assertNull($this->files->read($m->id));
	}

	public function testUnansweredForTenMinutesIsDiscardedByTheJob(): void {
		$s = $this->svc();
		$m = $s->start('room1', $this->who('priya'));
		$this->talk->call = false;
		$s->state('room1', $this->who('priya'));
		$this->now += 599;
		$this->assertSame(0, $s->expire());
		$this->now += 1;
		$this->assertSame(1, $s->expire());
		$this->assertSame(Meeting::DISCARDED, $this->store->get($m->id)->state);
		$this->assertNull($this->files->read($m->id));
	}

	public function testModeratorToolsGuestsCanEditLockAndFollowMe(): void {
		$s = $this->svc();
		$m = $s->start('room1', $this->who('priya'));
		$this->assertSame('view', $s->roleOf($m->id, 'guest-k'));
		try {
			$s->options('room1', $m->id, $this->who('jonas'), ['locked' => true]);
			$this->assertTrue(false, 'a participant locked');
		} catch (TalkException $e) {
			$this->assertSame('FORBIDDEN', $e->getMessage());
		}
		$s->options('room1', $m->id, $this->who('priya'), ['guestsCanEdit' => true]);
		$this->assertSame('edit', $s->roleOf($m->id, 'guest-k'));
		$s->options('room1', $m->id, $this->who('priya'), ['locked' => true]);
		$this->assertSame('view', $s->roleOf($m->id, 'jonas'));
		$this->assertSame('edit', $s->roleOf($m->id, 'priya'));
		// Follow me: only the moderator leads; everyone reads where they are.
		$s->follow('room1', $this->who('priya'), 'm:' . $m->id, true);
		$s->followView('room1', $this->who('priya'), 'b_intro');
		$s->followView('room1', $this->who('jonas'), 'b_other');
		$f = $s->state('room1', $this->who('jonas'))['follow'];
		$this->assertSame(['by' => 'priya', 'name' => 'Priya', 'canvas' => 'm:' . $m->id, 'block' => 'b_intro'], $f);
		$s->follow('room1', $this->who('priya'), '', false);
		$this->assertNull($s->state('room1', $this->who('jonas'))['follow']);
	}

	public function testGuestsNeverSaveOrDownload(): void {
		$s = $this->svc();
		$m = $s->start('room1', $this->who('priya'));
		$st = $s->state('room1', $this->who('guest-k'));
		$this->assertFalse($st['meeting']['canSave']);
		$this->assertFalse($st['meeting']['canDownload']);
		$this->assertFalse($st['canStart']);
		$this->assertSame('guest', $st['who']);
	}
}
