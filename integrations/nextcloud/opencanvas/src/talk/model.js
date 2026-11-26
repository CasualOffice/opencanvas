// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// TALK-01: what the Canvas panel in Talk shows (docs/prototypes/v04-approved/nextcloud-talk.html).
// Pure functions over the panel API's state (`GET /apps/opencanvas/talk/{room}/state`).

/** Talk's conversation token from its URL (`/call/{token}`, with or without index.php). */
export function roomFromPath(path) {
	const m = /\/call\/([a-z0-9]{4,32})(?:[/?#]|$)/i.exec(String(path ?? ''))
	return m ? m[1] : null
}

/**
 * Where the panel goes for a window this wide (2a-2c, 6b): `phone` under 45 rem (full screen with
 * a floating call tile), `sidebar` under 64 rem (a 25 rem sidebar tab, 1024 px included), else `beside` (38 rem).
 */
export function layoutFor(widthPx, remPx = 16) {
	const rem = widthPx / (remPx || 16)
	if (rem < 45) {
		return 'phone'
	}
	return rem <= 64 ? 'sidebar' : 'beside' // 1024 px (2c) is the sidebar tab
}

/** The status pill beside the panel title (3b, 3d, 4b). */
export function pill(meeting, who) {
	if (!meeting) {
		return null
	}
	if (meeting.state === 'ended') {
		return { text: 'Call ended · read only', tone: 'neutral' }
	}
	if (meeting.state !== 'active') {
		return null
	}
	if (meeting.role !== 'edit') {
		return { text: 'View only', tone: 'neutral' }
	}
	return { text: 'Temporary', tone: 'amber' }
}

/**
 * The banner over the meeting canvas: [text, kind]. Kind `save` adds "Save to Files" for
 * moderators; `open` adds "Open" for a saved one.
 */
export function banner(meeting, who) {
	if (!meeting) {
		return null
	}
	const mod = who === 'moderator'
	switch (meeting.state) {
	case 'active':
		if (who === 'guest') {
			return { text: meeting.guestsCanEdit && !meeting.locked ? "You're a guest. You can edit while the moderator allows it." : "You're a guest. The moderator decides whether guests can edit.", kind: 'info' }
		}
		if (meeting.locked && !mod) {
			return { text: 'A moderator locked this canvas. It is read only for now.', kind: 'info' }
		}
		return mod
			? { text: 'Temporary canvas. Deleted when the call ends unless you save it to Files.', kind: 'save' }
			: { text: 'Temporary canvas. A moderator can save it to Files before the call ends.', kind: 'info' }
	case 'ended':
		return mod
			? { text: 'The call ended. Save this canvas or discard it.', kind: 'decide' }
			: { text: 'The call ended. Waiting for a moderator to save or discard this canvas.', kind: 'wait' }
	case 'saved':
		return { text: 'Saved to Files', kind: 'open' }
	case 'discarded':
		return { text: 'The meeting canvas was discarded.', kind: 'gone' }
	}
	return null
}

/** Minutes left before an unanswered meeting canvas is discarded (3c), at least 0. */
export function minutesLeft(discardAt, nowMs) {
	if (!discardAt) {
		return 0
	}
	return Math.max(0, Math.ceil((discardAt * 1000 - nowMs) / 60000))
}

/** 1a: the access line in the post dialog, or '' when everyone can open it. */
export function missingText(missing, total) {
	if (!missing) {
		return ''
	}
	return `${missing} of ${total} participant${total === 1 ? '' : 's'} can't open this canvas yet.`
}

/**
 * Follow me: the block to scroll to when the leader moved, or null (we lead, it's another canvas,
 * nothing new). `canvas` is `m:<id>` or `f:<fileId>`.
 */
export function followTarget(follow, meId, canvas, lastBlock) {
	if (!follow || follow.by === meId || follow.canvas !== canvas || !follow.block || follow.block === lastBlock) {
		return null
	}
	return follow.block
}

/**
 * 5b: the error screen after a failed open; after two failures it names who to contact.
 */
export function openError(code, failures, adminContact) {
	const known = {
		NOT_CONFIGURED: 'OpenCanvas is not set up on this server yet.',
		GONE: 'This meeting canvas is no longer available.',
	}
	const description = known[code] ?? "The canvas server didn't respond. Your call isn't affected."
	const hint = failures >= 2 ? (adminContact ? `Still failing? Contact ${adminContact}.` : 'Still failing? Contact your administrator.') : ''
	return { title: "The canvas couldn't open", description, code: `OC-${code === 'GONE' ? 410 : 503}`, hint }
}

/** The 5a empty state's one primary action. */
export function emptyAction(state) {
	if (state?.callActive && state?.canStart) {
		return { id: 'start', label: 'Start a meeting canvas' }
	}
	return state?.who === 'guest' ? null : { id: 'files', label: 'Share from Files' }
}
