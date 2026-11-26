// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// The Nextcloud side of OpenCanvas's postMessage protocol (docs/05 §4, WOPI-style envelope
// { MessageId, SendTime, Values }). Pure: `reduce(state, message)` returns the next state and at
// most one effect for the component to run. The component checks the source window and origin.

export function initialState() {
	return { phase: 'loading', frameReady: false, expiring: 0 }
}

function parse(m) {
	if (typeof m === 'string') {
		try {
			return JSON.parse(m)
		} catch {
			return null
		}
	}
	return m
}

/**
 * @return {{state: object, effect: null | {type: 'loaded'} | {type: 'diagnose', code: string} |
 *   {type: 'close'} | {type: 'openFile', fileId: number} | {type: 'openUrl', url: string} |
 *   {type: 'relaunch'}}}
 */
export function reduce(state, raw) {
	const m = parse(raw)
	if (!m || typeof m !== 'object' || typeof m.MessageId !== 'string') {
		return { state, effect: null }
	}
	const v = m.Values && typeof m.Values === 'object' ? m.Values : {}
	switch (m.MessageId) {
	case 'App_LoadingStatus':
		if (v.Status === 'Frame_Ready') {
			return { state: { ...state, frameReady: true }, effect: null }
		}
		if (v.Status === 'Document_Loaded' && state.phase !== 'loaded') {
			return { state: { ...state, frameReady: true, phase: 'loaded' }, effect: { type: 'loaded' } }
		}
		return { state, effect: null }
	case 'Error':
		// Before the canvas is up, OpenCanvas shows a bare error page; we show the Nextcloud screen
		// (S13) instead, after asking the app what went wrong. During a session OpenCanvas's own
		// banners handle it (S4e, S4f, S13g).
		if (state.phase === 'loading') {
			return { state: { ...state, phase: 'error' }, effect: { type: 'diagnose', code: String(v.code ?? 'UNKNOWN') } }
		}
		return { state, effect: null }
	case 'UI_Close':
		return { state, effect: { type: 'close' } }
	case 'UI_Link_Click': {
		const id = Number(v.fileId)
		if (Number.isInteger(id) && id > 0) {
			return { state, effect: { type: 'openFile', fileId: id } }
		}
		const url = typeof v.url === 'string' ? v.url : ''
		return { state, effect: /^https?:\/\//i.test(url) ? { type: 'openUrl', url } : null }
	}
	case 'Token_Expiring': {
		// WOPI has no in-place token refresh (Action_RefreshToken is JWT-only), so renewing means a
		// relaunch. The first message is OpenCanvas's automatic heads-up: leave its banner up (S4j).
		// Any later one is "Reload now" / "Reload" (S4k): relaunch with a fresh token.
		const expiring = state.expiring + 1
		return { state: { ...state, expiring }, effect: expiring > 1 ? { type: 'relaunch' } : null }
	}
	default:
		return { state, effect: null }
	}
}

/**
 * SRCH-05: a unified search result links to `/apps/opencanvas/open/{id}#block=<id>`; once the
 * canvas is loaded the page sends `Action_ScrollToBlock` (docs/05 §4). Block ids only.
 */
export function blockFromHash(hash) {
	const m = /(?:^#|&)block=([A-Za-z0-9_-]{1,64})(?:&|$)/.exec(typeof hash === 'string' ? hash : '')
	return m ? m[1] : null
}
