// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// S4/S5 host side of the OpenCanvas postMessage protocol (docs/05 §4): when the canvas counts as
// loaded, which errors become a Nextcloud screen, closing, opening a conflict copy, relaunching.
import { describe, expect, it } from 'vitest'
import { blockFromHash, initialState, reduce } from '../../src/lib/bridge.js'

const msg = (MessageId, Values = {}) => ({ MessageId, SendTime: 1, Values })

describe('bridge.reduce', () => {
	it('S4a -> S4b: loading until Document_Loaded', () => {
		let s = initialState()
		expect(s.phase).toBe('loading')
		;({ state: s } = reduce(s, msg('App_LoadingStatus', { Status: 'Frame_Ready' })))
		expect(s.phase).toBe('loading')
		expect(s.frameReady).toBe(true)
		const r = reduce(s, msg('App_LoadingStatus', { Status: 'Document_Loaded' }))
		expect(r.state.phase).toBe('loaded')
		expect(r.effect).toEqual({ type: 'loaded' })
	})
	it('an Error before loading becomes a Nextcloud error screen (diagnosed)', () => {
		const r = reduce(initialState(), msg('Error', { code: 'NETWORK' }))
		expect(r.state.phase).toBe('error')
		expect(r.effect).toEqual({ type: 'diagnose', code: 'NETWORK' })
	})
	it('errors during a session stay inside OpenCanvas (its own banners)', () => {
		const loaded = { ...initialState(), phase: 'loaded', frameReady: true }
		expect(reduce(loaded, msg('Error', { code: 'SAVE_FAILED' })).effect).toBe(null)
	})
	it('UI_Close closes the view', () => {
		expect(reduce(initialState(), msg('UI_Close')).effect).toEqual({ type: 'close' })
	})
	it('S4l: "Open the copy" opens the conflict copy by file id', () => {
		const r = reduce({ ...initialState(), phase: 'loaded' }, msg('UI_Link_Click', { url: 'http://nc/index.php/f/77', fileId: '77' }))
		expect(r.effect).toEqual({ type: 'openFile', fileId: 77 })
	})
	it('other links open in a new tab', () => {
		const r = reduce({ ...initialState(), phase: 'loaded' }, msg('UI_Link_Click', { url: 'https://example.com/x' }))
		expect(r.effect).toEqual({ type: 'openUrl', url: 'https://example.com/x' })
	})
	it('refuses non-http links', () => {
		expect(reduce(initialState(), msg('UI_Link_Click', { url: 'javascript:alert(1)' })).effect).toBe(null)
	})
	it('S4j/S4k: the automatic Token_Expiring is left to OpenCanvas\'s banner; a later one (Reload) relaunches', () => {
		let s = { ...initialState(), phase: 'loaded' }
		let r = reduce(s, msg('Token_Expiring', { inSeconds: 300 }))
		expect(r.effect).toBe(null)
		r = reduce(r.state, msg('Token_Expiring', { inSeconds: 120 }))
		expect(r.effect).toEqual({ type: 'relaunch' })
	})
	it('ignores junk', () => {
		expect(reduce(initialState(), null).effect).toBe(null)
		expect(reduce(initialState(), { nope: 1 }).effect).toBe(null)
		expect(reduce(initialState(), '{"MessageId":"UI_Close"}').effect).toEqual({ type: 'close' })
	})
})

describe('blockFromHash (SRCH-05: a unified search result opens the canvas at its block)', () => {
	it('reads #block=<id> and nothing else', () => {
		expect(blockFromHash('#block=b_a10')).toBe('b_a10')
		expect(blockFromHash('#x=1&block=b-9')).toBe('b-9')
		expect(blockFromHash('#block=<script>')).toBe(null)
		expect(blockFromHash('')).toBe(null)
		expect(blockFromHash('#blocks=b_1')).toBe(null)
	})
})
