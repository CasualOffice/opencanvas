// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// S12 admin page: address validation before saving (S12h) and the check's headline (S12b-S12f).

const HTTP_HINT = 'Plain http is fine inside a private network, but don\'t use it across the internet.'

/** @return {{error?: string, hint?: string}} */
export function validateAddress(value, { internal }) {
	const v = String(value ?? '').trim()
	if (v === '') {
		return internal ? {} : { error: 'Enter your OpenCanvas server\'s address' }
	}
	let u
	try {
		u = new URL(v)
	} catch {
		u = null
	}
	if (!u || !['http:', 'https:'].includes(u.protocol) || !u.hostname || !/^https?:\/\//i.test(v)
		|| u.username || u.password || u.search || u.hash) {
		return { error: 'Enter a full address that starts with https://, for example https://canvas.example.com' }
	}
	return u.protocol === 'http:' ? { hint: HTTP_HINT } : {}
}

const HEADLINES = {
	answers: 'Can\'t connect',
	action: 'Connected, but canvases can\'t open',
	proofKey: 'Connected, but not secure yet',
	accepts: 'OpenCanvas doesn\'t accept this Nextcloud yet',
}

/** @param {{id: string, status: 'ok'|'fail'|'skipped'}[]|null} steps */
export function checkHeadline(steps) {
	if (!steps) {
		return { status: 'idle', title: 'Save an address to run the check' }
	}
	const failed = steps.find((s) => s.status === 'fail')
	return failed ? { status: 'fail', title: HEADLINES[failed.id] ?? 'Can\'t connect' } : { status: 'ok', title: 'Connected' }
}

/** "Checked just now", "Checked 3 minutes ago". */
export function checkedLabel(at, now = Date.now()) {
	const s = Math.max(0, Math.round((now - at) / 1000))
	if (s < 45) {
		return 'Checked just now'
	}
	const m = Math.round(s / 60)
	return m < 60 ? `Checked ${m} minute${m === 1 ? '' : 's'} ago` : 'Checked over an hour ago'
}
