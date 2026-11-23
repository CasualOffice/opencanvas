// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// S4: opens .ocanvas files in Nextcloud's Viewer (the default when clicking a canvas, S6b).
// Viewer (Nextcloud 30-32): OCA.Viewer.registerHandler({ id, mimes, component, theme }).
import { loadState } from '@nextcloud/initial-state'
import ViewerCanvas from './views/ViewerCanvas.vue'
import { MIME, installMimeIcon, watchMimeIcons } from './lib/mimeicon.js'

installMimeIcon()
watchMimeIcons()

/** A public link to one canvas: src/public.js shows it under Nextcloud's public header (S7). */
function isPublicCanvasPage() {
	try {
		return loadState('files_sharing', 'view', '') === 'public-file-share'
			&& /\.ocanvas$/i.test(loadState('files_sharing', 'filename', ''))
	} catch {
		return false
	}
}

function register() {
	if (!window.OCA?.Viewer || window.OCA.Viewer.mimetypes?.includes(MIME) || isPublicCanvasPage()) {
		return
	}
	window.OCA.Viewer.registerHandler({
		id: 'opencanvas',
		mimes: [MIME],
		component: ViewerCanvas,
		// Dark Viewer bar over a canvas area in Nextcloud's own background (S4b).
		theme: 'dark',
	})
}

if (window.OCA?.Viewer) {
	register()
} else {
	document.addEventListener('DOMContentLoaded', register)
}
