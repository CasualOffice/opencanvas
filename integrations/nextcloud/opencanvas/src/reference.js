// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// TALK-01: the canvas card in Talk (and anywhere Nextcloud renders link previews), for the rich
// object `opencanvas-canvas` from lib/Reference/CanvasReferenceProvider.php.
import Vue from 'vue'
import { registerWidget } from '@nextcloud/vue/dist/Functions/registerReference.js'
import CanvasCardWidget from './talk/CanvasCardWidget.vue'

registerWidget('opencanvas-canvas', (el, { richObject }) => {
	const Card = Vue.extend(CanvasCardWidget)
	return new Card({ propsData: { initial: richObject } }).$mount(el)
}, (el, vm) => vm?.$destroy?.(), {
	// The card is a couple of buttons, usable at once: no "Enable interactive view" overlay.
	hasInteractiveView: false,
})
