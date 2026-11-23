<!--
  - SPDX-License-Identifier: Apache-2.0
  - Copyright 2026 CasualOffice
  -
  - The canvas area shared by the Viewer (S4), the full page (S5) and public links (S7):
  - a Nextcloud spinner while the token is fetched and OpenCanvas loads (S4a, S5b), then the
  - OpenCanvas iframe (S4b), or a shared error screen (S13) when it can't open. Talks to OpenCanvas
  - through postMessage (src/lib/bridge.js).
  -->
<template>
	<div class="oc-frame" data-oc-frame :data-phase="phase">
		<form v-if="launch"
			ref="form"
			method="post"
			:target="frameName"
			:action="launch.action"
			class="oc-frame__form">
			<input type="hidden" name="access_token" :value="launch.access_token">
			<input type="hidden" name="access_token_ttl" :value="String(launch.access_token_ttl)">
		</form>
		<iframe v-if="launch"
			ref="iframe"
			:key="frameName"
			:name="frameName"
			class="oc-frame__iframe"
			:class="{ 'oc-frame__iframe--hidden': phase !== 'loaded' }"
			title="OpenCanvas"
			allow="clipboard-read; clipboard-write; fullscreen"
			@load="onFrameLoad" />
		<div v-if="phase === 'loading'" class="oc-frame__loading" data-oc-loading>
			<NcLoadingIcon :size="44" />
			<span>Opening “{{ displayName }}”…</span>
		</div>
		<ErrorScreen v-if="phase === 'error' && screen"
			:code="code"
			:screen="screen"
			@action="onAction" />
	</div>
</template>

<script>
import { generateUrl } from '@nextcloud/router'
import axios from '@nextcloud/axios'
import NcLoadingIcon from '@nextcloud/vue/dist/Components/NcLoadingIcon.js'
import ErrorScreen from './ErrorScreen.vue'
import { initialState, reduce } from '../lib/bridge.js'
import { codeFromError, errorScreen } from '../lib/errors.js'

/** OpenCanvas announces itself (Frame_Ready) almost at once; this long without it means trouble. */
const NO_ANSWER_MS = 20000
/** After the iframe loaded a page that never said Frame_Ready (a refused launch, a browser error page). */
const AFTER_LOAD_MS = 5000
let seq = 0

/** Light or dark from Nextcloud's own background colour, so the canvas follows the theme. */
export function nextcloudTheme() {
	const bg = getComputedStyle(document.body).getPropertyValue('--color-main-background').trim()
	const m = bg.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i)
	if (!m) {
		return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
	}
	const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16))
	return (0.299 * r + 0.587 * g + 0.114 * b) < 128 ? 'dark' : 'light'
}

export default {
	name: 'CanvasFrame',
	components: { ErrorScreen, NcLoadingIcon },
	props: {
		/** async () => launch data {action, access_token, access_token_ttl, origin}; throws {code, size} */
		fetchLaunch: { type: Function, required: true },
		/** The canvas name without .ocanvas, for "Opening …" */
		displayName: { type: String, default: '' },
		surface: { type: String, default: 'viewer' },
		isAdmin: { type: Boolean, default: false },
		canDownload: { type: Boolean, default: true },
		downloadUrl: { type: String, default: '' },
		owner: { type: String, default: '' },
		/** Set when the caller already knows the canvas can't open (e.g. links turned off). */
		presetError: { type: Object, default: null },
	},
	emits: ['loaded', 'close', 'open-file', 'error'],
	data() {
		return {
			phase: 'loading',
			launch: null,
			code: '',
			size: 0,
			bridge: initialState(),
			frameName: '',
			timers: [],
		}
	},
	computed: {
		screen() {
			if (!this.code) {
				return null
			}
			return errorScreen(this.code, {
				isAdmin: this.isAdmin,
				surface: this.surface,
				size: this.size,
				owner: this.owner,
				canDownload: this.canDownload && !!this.downloadUrl,
			})
		},
	},
	mounted() {
		window.addEventListener('message', this.onMessage)
		if (this.presetError) {
			this.fail(this.presetError.code, this.presetError.size)
		} else {
			this.start()
		}
	},
	beforeDestroy() {
		window.removeEventListener('message', this.onMessage)
		this.clearTimers()
	},
	methods: {
		clearTimers() {
			this.timers.forEach((t) => clearTimeout(t))
			this.timers = []
		},
		async start() {
			this.clearTimers()
			this.phase = 'loading'
			this.code = ''
			this.bridge = initialState()
			this.launch = null
			let data
			try {
				data = await this.fetchLaunch()
			} catch (e) {
				const { code, size } = codeFromError(e)
				this.fail(code, size)
				return
			}
			this.frameName = `opencanvas-frame-${++seq}`
			this.launch = data
			await this.$nextTick()
			this.$refs.form.submit()
			this.timers.push(setTimeout(() => this.noAnswer(), NO_ANSWER_MS))
		},
		fail(code, size) {
			this.clearTimers()
			this.phase = 'error'
			this.code = code
			this.size = Number(size ?? 0)
			this.$emit('error', code)
		},
		onFrameLoad() {
			if (!this.launch || this.bridge.frameReady || this.phase !== 'loading') {
				return
			}
			this.timers.push(setTimeout(() => this.noAnswer(), AFTER_LOAD_MS))
		},
		noAnswer() {
			if (this.phase === 'loading' && !this.bridge.frameReady) {
				this.diagnose()
			}
		},
		async diagnose() {
			this.phase = 'error'
			let code = 'UNREACHABLE'
			try {
				const { data } = await axios.get(generateUrl('/apps/opencanvas/api/v1/diagnose'))
				code = data?.error ?? code
			} catch {
				// Nextcloud itself didn't answer: the generic message fits
			}
			this.fail(code)
		},
		onMessage(event) {
			const frame = this.$refs.iframe
			if (!frame || event.source !== frame.contentWindow) {
				return
			}
			if (this.launch?.origin && event.origin !== this.launch.origin) {
				return
			}
			const { state, effect } = reduce(this.bridge, event.data)
			this.bridge = state
			if (state.frameReady && !this.readySent) {
				this.readySent = true
				this.post('Host_PostmessageReady', {})
			}
			if (!effect) {
				return
			}
			switch (effect.type) {
			case 'loaded':
				this.clearTimers()
				this.phase = 'loaded'
				this.post('Action_Theme', { theme: nextcloudTheme() })
				this.$emit('loaded')
				break
			case 'diagnose':
				this.diagnose()
				break
			case 'close':
				this.$emit('close')
				break
			case 'openFile':
				this.$emit('open-file', effect.fileId)
				break
			case 'openUrl':
				window.open(effect.url, '_blank', 'noopener,noreferrer')
				break
			case 'relaunch':
				this.readySent = false
				this.start()
				break
			}
		},
		post(MessageId, Values) {
			const w = this.$refs.iframe?.contentWindow
			if (w && this.launch?.origin) {
				w.postMessage({ MessageId, SendTime: Date.now(), Values }, this.launch.origin)
			}
		},
		onAction(id) {
			switch (id) {
			case 'retry':
				this.readySent = false
				this.start()
				break
			case 'close':
				this.$emit('close')
				break
			case 'admin':
			case 'check':
				window.location.href = generateUrl('/settings/admin/opencanvas')
				break
			case 'download':
				window.location.href = this.downloadUrl
				break
			case 'files':
				window.location.href = generateUrl('/apps/files/')
				break
			case 'trash':
				window.location.href = generateUrl('/apps/files/trashbin')
				break
			case 'reload':
				window.location.reload()
				break
			}
		},
	},
}
</script>

<style scoped>
.oc-frame {
	position: relative;
	width: 100%;
	height: 100%;
	background: var(--color-main-background);
	overflow: hidden;
}
.oc-frame__form {
	display: none;
}
.oc-frame__iframe {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	border: 0;
	display: block;
	background: var(--color-main-background);
}
.oc-frame__iframe--hidden {
	visibility: hidden;
}
.oc-frame__loading {
	position: absolute;
	inset: 0;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 16px;
	color: var(--color-text-maxcontrast);
	background: var(--color-main-background);
	padding: 16px;
	text-align: center;
}
</style>
