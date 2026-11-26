<?php

declare(strict_types=1);
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

namespace OCA\OpenCanvas\Tests\Unit;

use OCA\OpenCanvas\Talk\Meeting;
use OCA\OpenCanvas\Talk\MeetingPolicy as P;
use OCA\OpenCanvas\Wopi\Role;
use PHPUnit\Framework\TestCase;

/** TALK-01 (docs/prototypes/v04-approved/nextcloud-talk.html 3a-4b): who may do what with a meeting canvas. */
class MeetingPolicyTest extends TestCase {
	private function m(string $state = Meeting::ACTIVE): Meeting {
		return new Meeting(7, 'room1', $state, 'priya', 1000);
	}

	public function testModeratorsCanAlwaysStartParticipantsOnlyWhenAllowedGuestsNever(): void {
		$this->assertTrue(P::canStart(P::MODERATOR, false));
		$this->assertTrue(P::canStart(P::USER, true));
		$this->assertFalse(P::canStart(P::USER, false));
		$this->assertFalse(P::canStart(P::GUEST, true));
	}

	public function testDuringTheCallEveryoneEditsGuestsReadOnlyByDefault(): void {
		$m = $this->m();
		$this->assertSame(Role::EDIT, P::role($m, P::MODERATOR));
		$this->assertSame(Role::EDIT, P::role($m, P::USER));
		$this->assertSame(Role::VIEW, P::role($m, P::GUEST));
		$m->guestsCanEdit = true;
		$this->assertSame(Role::EDIT, P::role($m, P::GUEST));
	}

	public function testLockMakesEveryoneButModeratorsReadOnly(): void {
		$m = $this->m();
		$m->guestsCanEdit = true;
		$m->locked = true;
		$this->assertSame(Role::EDIT, P::role($m, P::MODERATOR));
		$this->assertSame(Role::VIEW, P::role($m, P::USER));
		$this->assertSame(Role::VIEW, P::role($m, P::GUEST));
	}

	public function testAfterTheCallEveryoneIsReadOnlyUntilTheModeratorDecides(): void {
		$m = $this->m(Meeting::ENDED);
		foreach ([P::MODERATOR, P::USER, P::GUEST] as $who) {
			$this->assertSame(Role::VIEW, P::role($m, $who));
		}
		$this->assertNull(P::role($this->m(Meeting::DISCARDED), P::USER));
		$this->assertNull(P::role($this->m(Meeting::SAVED), P::MODERATOR));
	}

	public function testOnlyModeratorsSaveAndGuestsNeverSaveOrDownload(): void {
		$this->assertTrue(P::canSave($this->m(), P::MODERATOR));
		$this->assertTrue(P::canSave($this->m(Meeting::ENDED), P::MODERATOR));
		$this->assertFalse(P::canSave($this->m(Meeting::DISCARDED), P::MODERATOR));
		$this->assertFalse(P::canSave($this->m(), P::USER));
		$this->assertFalse(P::canSave($this->m(), P::GUEST));
		$this->assertTrue(P::canDownload(P::USER));
		$this->assertFalse(P::canDownload(P::GUEST));
	}

	public function testCallEndWithAModeratorAsksThemWithoutOneDiscards(): void {
		$m = $this->m();
		$m->moderatorSeen = true;
		P::callEnded($m, 5000);
		$this->assertSame(Meeting::ENDED, $m->state);
		$this->assertSame(5000, $m->endedAt);
		$m2 = $this->m();
		P::callEnded($m2, 5000);
		$this->assertSame(Meeting::DISCARDED, $m2->state);
	}

	public function testNoDecisionWithinTenMinutesDiscards(): void {
		$m = $this->m();
		$m->moderatorSeen = true;
		P::callEnded($m, 5000);
		$this->assertFalse(P::settle($m, 5000 + 599));
		$this->assertSame(Meeting::ENDED, $m->state);
		$this->assertTrue(P::settle($m, 5000 + 600));
		$this->assertSame(Meeting::DISCARDED, $m->state);
		$this->assertSame(600, P::DECISION_SECONDS);
	}

	public function testOnlyTheModeratorSetsOptions(): void {
		$this->assertTrue(P::canModerate($this->m(), P::MODERATOR));
		$this->assertFalse(P::canModerate($this->m(), P::USER));
		$this->assertFalse(P::canModerate($this->m(Meeting::ENDED), P::MODERATOR));
	}
}
