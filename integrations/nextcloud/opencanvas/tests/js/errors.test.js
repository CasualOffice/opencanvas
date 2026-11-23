// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// S13 shared errors (and S4g-S4i, S5d, S7f): one message per code, admin vs. user variants.
import { describe, expect, it } from 'vitest'
import { codeFromError, codeFromResponse, errorScreen, formatSize } from '../../src/lib/errors.js'

const ids = (s) => s.actions.map((a) => a.id)

describe('errorScreen', () => {
	it('S13a/S4h: not set up, user sees a calm message and only Close', () => {
		const s = errorScreen('NOT_CONFIGURED', { isAdmin: false, surface: 'viewer' })
		expect(s.title).toBe('Canvases can\'t open yet')
		expect(s.description).toBe('Your administrator still needs to connect Nextcloud to OpenCanvas. Your file is safe and nothing was changed.')
		expect(ids(s)).toEqual(['close'])
		expect(s.icon).toBe('plug')
	})
	it('S13b/S4i: not set up, admin gets the admin settings link first', () => {
		const s = errorScreen('NOT_CONFIGURED', { isAdmin: true, surface: 'viewer' })
		expect(s.title).toBe('Finish setting up OpenCanvas')
		expect(ids(s)).toEqual(['admin', 'close'])
		expect(s.actions[0].primary).toBe(true)
	})
	it('S13c/S4g: unreachable offers Try again', () => {
		const s = errorScreen('UNREACHABLE', { surface: 'viewer' })
		expect(s.title).toBe('Can\'t reach OpenCanvas')
		expect(ids(s)).toEqual(['retry', 'close'])
		expect(s.icon).toBe('cloudOff')
	})
	it('S4n: on the full page there is nothing to close', () => {
		expect(ids(errorScreen('UNREACHABLE', { surface: 'page' }))).toEqual(['retry'])
	})
	it('S13d/S13e: proof rejected, no jargon for users, a fix for admins', () => {
		const u = errorScreen('PROOF_REJECTED', { isAdmin: false, surface: 'viewer' })
		expect(u.title).toBe('This canvas couldn\'t open safely')
		expect(u.description).not.toMatch(/key|proof/i)
		const a = errorScreen('PROOF_REJECTED', { isAdmin: true, surface: 'viewer' })
		expect(a.description).toMatch(/security key/)
		expect(a.hint).toMatch(/new proof key/)
		expect(ids(a)).toEqual(['check'])
	})
	it('S13f: too large names the size and offers Download', () => {
		const s = errorScreen('TOO_LARGE', { size: 132 * 1024 * 1024, surface: 'viewer', canDownload: true })
		expect(s.description).toBe('Canvases can be up to 100 MB, and this one is 132 MB, mostly images. You can still download it, or ask the owner to remove some images.')
		expect(ids(s)).toEqual(['download', 'close'])
	})
	it('S13f: no Download when the share forbids it', () => {
		expect(ids(errorScreen('TOO_LARGE', { size: 2e8, surface: 'viewer', canDownload: false }))).toEqual(['close'])
	})
	it('S13h: no permission leads back to Files', () => {
		const s = errorScreen('NO_PERMISSION', { surface: 'viewer' })
		expect(s.title).toBe('You don\'t have access to this canvas')
		expect(ids(s)).toEqual(['files'])
	})
	it('S13i: not found offers Deleted files; S5d on the full page offers Go to Files', () => {
		const v = errorScreen('NOT_FOUND', { surface: 'viewer' })
		expect(v.title).toBe('This canvas isn\'t available')
		expect(ids(v)).toEqual(['trash', 'close'])
		const p = errorScreen('NOT_FOUND', { surface: 'page' })
		expect(p.description).toBe('It may have been deleted or moved, or it isn\'t shared with you. Check Deleted files, or ask whoever sent you the link.')
		expect(ids(p)).toEqual(['files'])
		expect(p.pageTitle).toBe('Canvas not found')
	})
	it('S7f: links turned off names the owner, no actions', () => {
		const s = errorScreen('LINKS_DISABLED', { owner: 'Priya Raman', surface: 'public' })
		expect(s.title).toBe('This canvas can\'t be opened from a link')
		expect(s.description).toBe('Opening canvases from public links is turned off on this Nextcloud. Ask Priya Raman to share it with your account instead.')
		expect(ids(s)).toEqual([])
	})
	it('guests never get Files or admin actions', () => {
		expect(ids(errorScreen('NOT_FOUND', { surface: 'public' }))).toEqual([])
		expect(ids(errorScreen('NOT_CONFIGURED', { surface: 'public', isAdmin: true }))).toEqual([])
	})
	it('an unknown code falls back to the unreachable message', () => {
		expect(errorScreen('SOMETHING', { surface: 'viewer' }).title).toBe('Can\'t reach OpenCanvas')
	})
})

describe('codeFromResponse', () => {
	it('reads the app\'s error codes', () => {
		expect(codeFromResponse(503, { error: 'NOT_CONFIGURED' })).toBe('NOT_CONFIGURED')
		expect(codeFromResponse(413, { error: 'TOO_LARGE', size: 5 })).toBe('TOO_LARGE')
		expect(codeFromResponse(404, { error: 'NOT_AVAILABLE' })).toBe('LINKS_DISABLED')
	})
	it('maps bare statuses', () => {
		expect(codeFromResponse(404, null)).toBe('NOT_FOUND')
		expect(codeFromResponse(403, null)).toBe('NO_PERMISSION')
		expect(codeFromResponse(0, null)).toBe('UNREACHABLE')
		expect(codeFromResponse(500, 'oops')).toBe('UNREACHABLE')
	})
})

describe('formatSize', () => {
	it('rounds to whole MB like the prototype', () => {
		expect(formatSize(132 * 1024 * 1024)).toBe('132 MB')
		expect(formatSize(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB')
	})
})

describe('codeFromError', () => {
	it('reads the answer of a failed axios call, not axios\'s own error code', () => {
		// axios sets e.code = 'ERR_BAD_REQUEST' on every 4xx: a 413 TOO_LARGE once showed "Can't reach OpenCanvas".
		const e = { code: 'ERR_BAD_REQUEST', response: { status: 413, data: { error: 'TOO_LARGE', size: 106000000 } } }
		expect(codeFromError(e)).toEqual({ code: 'TOO_LARGE', size: 106000000 })
	})
	it('no answer at all is unreachable', () => {
		expect(codeFromError({ code: 'ERR_NETWORK' })).toEqual({ code: 'UNREACHABLE', size: 0 })
	})
})
