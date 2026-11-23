// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// S7: guests on edit links give a name first ("Saved in this browser so you won't be asked
// again"); view-only guests show as "Guest".

const UPDATE = 2
const KEY = 'opencanvas-guest-name'

export function needsGuestName(sharePermissions) {
	return (Number(sharePermissions) & UPDATE) !== 0
}

export function cleanGuestName(name) {
	return String(name ?? '').trim().slice(0, 64)
}

export function savedGuestName() {
	try {
		return cleanGuestName(window.localStorage.getItem(KEY))
	} catch {
		return ''
	}
}

export function saveGuestName(name) {
	try {
		window.localStorage.setItem(KEY, cleanGuestName(name))
	} catch {
		// private window or blocked storage: the guest is asked again next time
	}
}
