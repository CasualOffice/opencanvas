// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// TALK-01: the Canvas panel on Talk's pages (signed in and public conversations).
import Vue from 'vue'
import TalkPanel from './talk/TalkPanel.vue'

function mount() {
	if (document.getElementById('opencanvas-talk')) {
		return
	}
	const el = document.createElement('div')
	el.id = 'opencanvas-talk'
	document.body.appendChild(el)
	// eslint-disable-next-line no-new
	new Vue({ el, render: (h) => h(TalkPanel) })
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', mount)
} else {
	mount()
}
