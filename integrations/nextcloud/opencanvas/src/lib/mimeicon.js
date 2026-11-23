// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// S2: the indigo .ocanvas icon in Files, the Viewer, Talk and public pages. Nextcloud resolves
// file-type icons only from core/img/filetypes (OC.MimeType.getIconUrl in the browser, and the
// /core/mimeicon endpoint the Files list uses). Writing into core would trip Nextcloud's integrity
// check, so the browser side answers our type with the app's icon instead:
//  - OC.MimeType.getIconUrl returns it for our type;
//  - images pointing at /core/mimeicon?mime=<our type> are pointed at it (MutationObserver).
// Server-rendered places (emails, activity) keep the generic document icon (README, Limits).
import { imagePath } from '@nextcloud/router'

export const MIME = 'application/vnd.opencanvas+zip'

export function iconUrl() {
	return imagePath('opencanvas', 'ocanvas.svg')
}

export function installMimeIcon(win = window) {
	const mt = win.OC?.MimeType
	if (!mt || typeof mt.getIconUrl !== 'function' || mt.getIconUrl.__opencanvas) {
		return false
	}
	const original = mt.getIconUrl.bind(mt)
	const patched = (mime) => (mime === MIME ? iconUrl() : original(mime))
	patched.__opencanvas = true
	mt.getIconUrl = patched
	return true
}

export function isOurMimeIconUrl(src) {
	if (!src || !src.includes('/core/mimeicon')) {
		return false
	}
	// Not URLSearchParams: it would read a literal "+" as a space.
	const m = src.match(/[?&]mime=([^&#]*)/)
	try {
		return m !== null && decodeURIComponent(m[1]) === MIME
	} catch {
		return false
	}
}

export function rewriteIcons(root) {
	const imgs = root.tagName === 'IMG' ? [root] : root.querySelectorAll?.('img[src*="/core/mimeicon"]') ?? []
	for (const img of imgs) {
		if (isOurMimeIconUrl(img.getAttribute('src'))) {
			img.setAttribute('src', iconUrl())
		}
	}
}

let observing = false
export function watchMimeIcons(doc = document) {
	if (observing || typeof MutationObserver === 'undefined') {
		return
	}
	observing = true
	const start = () => {
		rewriteIcons(doc.body)
		new MutationObserver((records) => {
			for (const r of records) {
				if (r.type === 'attributes') {
					rewriteIcons(r.target)
				} else {
					r.addedNodes.forEach((n) => n.nodeType === 1 && rewriteIcons(n))
				}
			}
		}).observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] })
	}
	if (doc.body) {
		start()
	} else {
		doc.addEventListener('DOMContentLoaded', start)
	}
}
