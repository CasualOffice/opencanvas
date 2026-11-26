// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// TALK-01: the Canvas panel's states (docs/prototypes/v04-approved/nextcloud-talk.html).
import { describe, expect, it } from 'vitest'
import { banner, emptyAction, followTarget, layoutFor, minutesLeft, missingText, openError, pill, roomFromPath } from '../../src/talk/model.js'

const active = { state: 'active', role: 'edit', guestsCanEdit: false, locked: false }

describe('Talk panel', () => {
	it('reads the conversation from the Talk URL', () => {
		expect(roomFromPath('/index.php/call/abc123xy')).toBe('abc123xy')
		expect(roomFromPath('/call/abc123xy#message_5')).toBe('abc123xy')
		expect(roomFromPath('/apps/files/')).toBeNull()
	})

	it('beside the call from 64 rem, a sidebar tab under it, full screen on a phone (2a, 2c, 6b)', () => {
		expect(layoutFor(1280)).toBe('beside')
		expect(layoutFor(1024)).toBe('sidebar')
		expect(layoutFor(390)).toBe('phone')
		// At a 24 px root 1280 px is 53 rem: the sidebar tab.
		expect(layoutFor(1280, 24)).toBe('sidebar')
	})

	it('pills: Temporary, View only, Call ended', () => {
		expect(pill(active, 'user')).toEqual({ text: 'Temporary', tone: 'amber' })
		expect(pill({ ...active, role: 'view' }, 'guest').text).toBe('View only')
		expect(pill({ state: 'ended' }, 'user').text).toBe('Call ended · read only')
	})

	it('banners name the reason; moderators get Save, participants wait (3b, 3c, 3d, 4b)', () => {
		expect(banner(active, 'moderator').kind).toBe('save')
		expect(banner(active, 'user').text).toMatch(/moderator can save it to Files/)
		expect(banner({ ...active, role: 'view' }, 'guest').text).toBe("You're a guest. The moderator decides whether guests can edit.")
		expect(banner({ ...active, locked: true }, 'user').text).toMatch(/locked/)
		expect(banner({ state: 'ended' }, 'moderator').kind).toBe('decide')
		expect(banner({ state: 'ended' }, 'user').text).toMatch(/Waiting for a moderator/)
		expect(banner({ state: 'saved' }, 'user')).toEqual({ text: 'Saved to Files', kind: 'open' })
	})

	it('counts the minutes left before an unanswered canvas is discarded', () => {
		expect(minutesLeft(1000 + 600, 1000 * 1000)).toBe(10)
		expect(minutesLeft(1000, 2000 * 1000)).toBe(0)
	})

	it('says how many participants can not open the canvas (1a)', () => {
		expect(missingText(2, 6)).toBe("2 of 6 participants can't open this canvas yet.")
		expect(missingText(0, 6)).toBe('')
	})

	it('follows the leader on the same canvas only, once per move', () => {
		const f = { by: 'priya', canvas: 'm:3', block: 'b_x' }
		expect(followTarget(f, 'jonas', 'm:3', null)).toBe('b_x')
		expect(followTarget(f, 'jonas', 'm:3', 'b_x')).toBeNull()
		expect(followTarget(f, 'priya', 'm:3', null)).toBeNull()
		expect(followTarget(f, 'jonas', 'f:9', null)).toBeNull()
	})

	it('error screen: retry first, then the admin contact (5b)', () => {
		expect(openError('UNREACHABLE', 1, 'ops@example.org')).toEqual({ title: "The canvas couldn't open", description: "The canvas server didn't respond. Your call isn't affected.", code: 'OC-503', hint: '' })
		expect(openError('UNREACHABLE', 2, 'ops@example.org').hint).toBe('Still failing? Contact ops@example.org.')
	})

	it('empty state: start a meeting canvas in a call, otherwise share from Files (5a)', () => {
		expect(emptyAction({ callActive: true, canStart: true, who: 'user' }).id).toBe('start')
		expect(emptyAction({ callActive: false, canStart: true, who: 'user' }).id).toBe('files')
		expect(emptyAction({ callActive: false, who: 'guest' })).toBeNull()
	})
})
