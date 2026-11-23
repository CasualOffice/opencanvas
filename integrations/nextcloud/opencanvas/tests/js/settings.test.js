// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// S12 admin page logic: address validation (S12h), the check headline (S12b-S12f), guest names (S7b).
import { describe, expect, it } from 'vitest'
import { checkHeadline, validateAddress } from '../../src/lib/settings.js'
import { cleanGuestName, needsGuestName } from '../../src/lib/guest.js'

describe('validateAddress (S12h)', () => {
	it('requires a full address for the OpenCanvas address', () => {
		expect(validateAddress('canvas.northwind', { internal: false }))
			.toEqual({ error: 'Enter a full address that starts with https://, for example https://canvas.example.com' })
		expect(validateAddress('', { internal: false })).toEqual({ error: 'Enter your OpenCanvas server\'s address' })
	})
	it('accepts https quietly', () => {
		expect(validateAddress('https://canvas.northwind.example', { internal: false })).toEqual({})
	})
	it('plain http only gets a quiet hint', () => {
		expect(validateAddress('http://opencanvas:8080', { internal: true }))
			.toEqual({ hint: 'Plain http is fine inside a private network, but don\'t use it across the internet.' })
	})
	it('the internal address may be empty', () => {
		expect(validateAddress('', { internal: true })).toEqual({})
	})
	it('refuses query strings and credentials', () => {
		expect(validateAddress('https://u:p@x.example', { internal: false }).error).toBeTruthy()
		expect(validateAddress('https://x.example/?a=1', { internal: false }).error).toBeTruthy()
	})
})

describe('checkHeadline', () => {
	const steps = (...st) => ['answers', 'action', 'proofKey', 'accepts'].map((id, i) => ({ id, status: st[i] }))
	it('S12b connected', () => expect(checkHeadline(steps('ok', 'ok', 'ok', 'ok'))).toEqual({ status: 'ok', title: 'Connected' }))
	it('S12c', () => expect(checkHeadline(steps('fail', 'skipped', 'skipped', 'skipped')).title).toBe('Can\'t connect'))
	it('S12d', () => expect(checkHeadline(steps('ok', 'fail', 'skipped', 'skipped')).title).toBe('Connected, but canvases can\'t open'))
	it('S12e', () => expect(checkHeadline(steps('ok', 'ok', 'fail', 'skipped')).title).toBe('Connected, but not secure yet'))
	it('S12f', () => expect(checkHeadline(steps('ok', 'ok', 'ok', 'fail')).title).toBe('OpenCanvas doesn\'t accept this Nextcloud yet'))
	it('S12a no address', () => expect(checkHeadline(null)).toEqual({ status: 'idle', title: 'Save an address to run the check' }))
})

describe('guest names (S7b)', () => {
	it('edit links ask for a name, view-only links do not', () => {
		expect(needsGuestName(19)).toBe(true) // read + update + share
		expect(needsGuestName(1)).toBe(false)
		expect(needsGuestName(17)).toBe(false)
	})
	it('trims and caps the name', () => {
		expect(cleanGuestName('  Sam Carter  ')).toBe('Sam Carter')
		expect(cleanGuestName('x'.repeat(100))).toHaveLength(64)
		expect(cleanGuestName('   ')).toBe('')
	})
})
