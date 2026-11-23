// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// S5: the full page at /apps/opencanvas/open/{id} (templates/editor.php).
import Vue from 'vue'
import { loadState } from '@nextcloud/initial-state'
import FullPage from './views/FullPage.vue'
import { installMimeIcon, watchMimeIcons } from './lib/mimeicon.js'
import './fullpage.css'

installMimeIcon()
watchMimeIcons()

const el = document.getElementById('opencanvas-fullpage')
if (el) {
	const state = loadState('opencanvas', 'page', {})
	// eslint-disable-next-line no-new
	new Vue({ el, render: (h) => h(FullPage, { props: { state } }) })
}
