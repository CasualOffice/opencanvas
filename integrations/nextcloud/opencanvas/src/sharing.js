// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// S8 in Nextcloud's sharing sidebar (Nextcloud 31: @nextcloud/sharing/ui, custom elements):
//  - S8a: "What this means in a canvas", a card under the shares of an .ocanvas file;
//  - S8b: "Can comment in OpenCanvas" in a share's advanced settings, only when the admin turned
//    on the comment role (S12). It sets the share attribute opencanvas/comment, which
//    PermissionMapper turns into the comment role for view-only shares.
import Vue from 'vue'
import axios from '@nextcloud/axios'
import { generateOcsUrl } from '@nextcloud/router'
import { registerSidebarAction, registerSidebarSection } from '@nextcloud/sharing/ui'
import ShareCard from './components/ShareCard.vue'
import CommentOption from './components/CommentOption.vue'
import { MIME } from './lib/mimeicon.js'

const UPDATE = 2

/** Our share attribute, merged into the share's other attributes. */
export function withComment(attributes, value) {
	const rest = (attributes ?? []).filter((a) => !(a.scope === 'opencanvas' && a.key === 'comment'))
	return [...rest, { scope: 'opencanvas', key: 'comment', value: !!value }]
}

export function hasComment(attributes) {
	return (attributes ?? []).some((a) => a.scope === 'opencanvas' && a.key === 'comment' && (a.value === true || a.enabled === true))
}

function define(tag, mount) {
	if (window.customElements.get(tag)) {
		return
	}
	window.customElements.define(tag, class extends HTMLElement {
		connectedCallback() {
			// Nextcloud sets `node`, `share` and `onSave` as properties right after creating us.
			setTimeout(() => {
				if (!this.vm) {
					const el = document.createElement('div')
					this.appendChild(el)
					this.vm = mount(this, el)
				}
			}, 0)
		}

		disconnectedCallback() {
			this.vm?.$destroy()
			this.vm = null
			this.innerHTML = ''
		}
	})
}

export function registerSharing({ commentRole }) {
	try {
		define('oca_opencanvas-share-card', (host, el) => new Vue({ el, render: (h) => h(ShareCard, { props: { commentRole } }) }))
		registerSidebarSection({
			id: 'opencanvas-share-card',
			element: 'oca_opencanvas-share-card',
			order: 90,
			enabled: (node) => node?.mime === MIME,
		})
	} catch (e) {
		console.warn('OpenCanvas: sharing card not registered', e)
	}
	if (!commentRole) {
		return
	}
	try {
		define('oca_opencanvas-comment-option', (host, el) => {
			const share = host.share
			const vm = new Vue({
				el,
				data: { checked: hasComment(share?.attributes), editable: !!(share && (share.permissions & UPDATE)) },
				render(h) {
					return h(CommentOption, {
						props: { checked: this.checked, hidden: this.editable, name: share?.shareWithDisplayName ?? '' },
						on: { 'update:checked': (v) => { this.checked = v } },
					})
				},
			})
			// The permission radio above us can change while the details are open: only view-only
			// shares can be commenters, so follow it.
			const poll = setInterval(() => { vm.editable = !!(share && (share.permissions & UPDATE)) }, 400)
			vm.$once('hook:beforeDestroy', () => clearInterval(poll))
			host.onSave?.(async () => {
				if (!share?.id) {
					return
				}
				const attributes = withComment(share.attributes, vm.checked && !vm.editable)
				await axios.put(generateOcsUrl('/apps/files_sharing/api/v1/shares/{id}', { id: share.id }), {
					attributes: JSON.stringify(attributes),
				})
			})
			return vm
		})
		registerSidebarAction({
			id: 'opencanvas-comment-option',
			element: 'oca_opencanvas-comment-option',
			order: 50,
			enabled: (share, node) => node?.mime === MIME && share?.shareType !== 3 && share?.shareType !== 4,
		})
	} catch (e) {
		console.warn('OpenCanvas: comment option not registered', e)
	}
}
