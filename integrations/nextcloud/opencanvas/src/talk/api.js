// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// TALK-01: the app's Talk panel API (lib/Controller/TalkController.php) and Talk's own OCS chat
// API (conversations, posting a message, reading the chat for canvases shared in it).
import axios from '@nextcloud/axios'
import { generateOcsUrl, generateUrl } from '@nextcloud/router'

const url = (room, path = '') => generateUrl('/apps/opencanvas/talk/{room}' + path, { room })

export const getState = async (room) => (await axios.get(url(room, '/state'))).data
export const startMeeting = async (room) => (await axios.post(url(room, '/meeting'))).data
export const meetingLaunch = async (room, id) => (await axios.post(url(room, `/meeting/${Number(id)}/launch`))).data
export const decide = async (room, id, action, post) => (await axios.post(url(room, `/meeting/${Number(id)}/decide`), { action, post })).data
export const setOptions = async (room, id, opts) => (await axios.post(url(room, `/meeting/${Number(id)}/options`), opts)).data
export const setParticipantsCanStart = async (room, on) => (await axios.post(url(room, '/settings'), { participantsCanStart: on })).data
export const setFollow = async (room, canvas, on) => (await axios.post(url(room, '/follow'), { canvas, on })).data
export const followView = async (room, block) => (await axios.post(url(room, '/follow/view'), { block })).data
export const accessFor = async (room, fileId) => (await axios.get(url(room, `/access/${Number(fileId)}`))).data
export const shareToRoom = async (room, fileId, level) => (await axios.post(url(room, `/share/${Number(fileId)}`), { level })).data

/** The conversations this person is in (Talk OCS), most recent first. */
export async function conversations() {
	const { data } = await axios.get(generateOcsUrl('apps/spreed/api/v4/room'), { headers: { 'OCS-APIRequest': 'true' } })
	return (data?.ocs?.data ?? [])
		.filter((r) => r.type !== 4) // not the changelog conversation
		.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
		.map((r) => ({ token: r.token, name: r.displayName, participants: r.participantCount ?? null }))
}

/** Posts a chat message as this person (Talk OCS). */
export async function postMessage(room, message, replyTo = 0) {
	const body = { message, actorDisplayName: '' }
	if (replyTo) {
		body.replyTo = replyTo
	}
	await axios.post(generateOcsUrl('apps/spreed/api/v1/chat/{token}', { token: room }), body, { headers: { 'OCS-APIRequest': 'true' } })
}

const CANVAS_LINK = /\/apps\/opencanvas\/open\/(\d+)/
const MIME = 'application/vnd.opencanvas+zip'

/**
 * 3a "Open a shared canvas": canvases posted to this conversation (card links and .ocanvas files
 * shared with it), newest first, from the last 200 messages.
 */
export async function sharedCanvases(room) {
	const { data } = await axios.get(generateOcsUrl('apps/spreed/api/v1/chat/{token}', { token: room }), {
		params: { lookIntoFuture: 0, limit: 200, setReadMarker: 0 },
		headers: { 'OCS-APIRequest': 'true' },
	})
	return canvasesInChat(data?.ocs?.data ?? [])
}

/** Pure: the canvases in a list of Talk chat messages (exported for the unit tests). */
export function canvasesInChat(messages) {
	const seen = new Map()
	for (const m of messages) {
		const file = m?.messageParameters?.file
		if (file && file.mimetype === MIME && !seen.has(Number(file.id))) {
			seen.set(Number(file.id), { fileId: Number(file.id), title: String(file.name ?? '').replace(/\.ocanvas$/i, ''), by: m.actorDisplayName ?? '' })
		}
		const hit = CANVAS_LINK.exec(String(m?.message ?? ''))
		if (hit && !seen.has(Number(hit[1]))) {
			seen.set(Number(hit[1]), { fileId: Number(hit[1]), title: '', by: m.actorDisplayName ?? '' })
		}
	}
	return [...seen.values()]
}
