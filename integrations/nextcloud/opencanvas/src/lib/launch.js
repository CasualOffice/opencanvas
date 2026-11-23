// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// Fetching launch data from the app (docs/05 §6 "Launch"): a signed-in user, or a guest on a
// public link. Errors keep the axios response, which CanvasFrame turns into an S13 screen.
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

export async function userLaunch(fileId) {
	const { data } = await axios.post(generateUrl('/apps/opencanvas/api/v1/token/{fileId}', { fileId }))
	return data
}

export async function guestLaunch(shareToken, fileId, guestName) {
	const { data } = await axios.post(
		generateUrl('/apps/opencanvas/api/v1/share/{shareToken}/token/{fileId}', { shareToken, fileId }),
		{ guestName: guestName ?? '' },
	)
	return data
}

export async function publicInfo(shareToken) {
	const { data } = await axios.get(generateUrl('/apps/opencanvas/api/v1/share/{shareToken}/info', { shareToken }))
	return data
}

/** "Q1 launch plan.ocanvas" -> "Q1 launch plan" */
export function stripExtension(name) {
	return String(name ?? '').replace(/\.ocanvas$/i, '')
}
