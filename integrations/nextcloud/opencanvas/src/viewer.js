// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// UNSTYLED PLACEHOLDER (ADR-011). Registers a Viewer handler for .ocanvas that shows the
// OpenCanvas iframe; chrome, loading, errors and the Talk side-by-side layout wait for an
// approved prototype (UI-SCREENS.md). NOT BUILT OR RUN: bundle to js/opencanvas-viewer.js.
// Viewer (Nextcloud 30-32): OCA.Viewer.registerHandler({ id, mimes, component }).
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

const OpenCanvasFrame = {
	name: 'OpenCanvasFrame',
	props: { fileid: { type: Number, required: true } },
	data: () => ({ launch: null, error: null }),
	async mounted() {
		try {
			const { data } = await axios.post(generateUrl('/apps/opencanvas/api/v1/token/{fileId}', { fileId: this.fileid }))
			this.launch = data
			this.$nextTick(() => this.$refs.form.submit())
		} catch (e) {
			this.error = e?.response?.data?.error || 'ERROR'
		}
		this.$emit('update:loaded', true)
	},
	render(h) {
		if (this.error) return h('p', `OpenCanvas: ${this.error}`)
		if (!this.launch) return h('p', 'Loading')
		const name = `opencanvas-${this.fileid}`
		return h('div', [
			h('form', { ref: 'form', attrs: { method: 'post', target: name, action: this.launch.action } }, [
				h('input', { attrs: { type: 'hidden', name: 'access_token', value: this.launch.access_token } }),
				h('input', { attrs: { type: 'hidden', name: 'access_token_ttl', value: String(this.launch.access_token_ttl) } }),
			]),
			h('iframe', { attrs: { name, title: 'OpenCanvas', allow: 'clipboard-read; clipboard-write; fullscreen' } }),
		])
	},
}

if (window.OCA?.Viewer) {
	window.OCA.Viewer.registerHandler({
		id: 'opencanvas',
		mimes: ['application/vnd.opencanvas+zip'],
		component: OpenCanvasFrame,
		theme: 'default',
	})
}
