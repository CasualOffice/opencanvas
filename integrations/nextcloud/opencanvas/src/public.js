// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// S7: the public link page of a single .ocanvas file (loaded by LoadPublicScripts only for those).
// Nextcloud 31 shows a public file share as a one-file list; for a canvas we show the canvas
// itself under Nextcloud's public header instead.
import Vue from 'vue'
import { loadState } from '@nextcloud/initial-state'
import PublicCanvas from './views/PublicCanvas.vue'
import { installMimeIcon, watchMimeIcons } from './lib/mimeicon.js'
import './public.css'

installMimeIcon()
watchMimeIcons()

function mount() {
	const content = document.getElementById('content') ?? document.getElementById('content-vue')
	const shareToken = loadState('files_sharing', 'sharingToken', null)
	if (!content || !shareToken || loadState('files_sharing', 'view', '') !== 'public-file-share') {
		return
	}
	document.body.classList.add('opencanvas-public')
	const el = document.createElement('div')
	el.id = 'opencanvas-public'
	content.parentNode.insertBefore(el, content.nextSibling)
	// eslint-disable-next-line no-new
	new Vue({
		el,
		render: (h) => h(PublicCanvas, { props: { shareToken, fileName: loadState('files_sharing', 'filename', '') } }),
	})
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', mount)
} else {
	mount()
}
