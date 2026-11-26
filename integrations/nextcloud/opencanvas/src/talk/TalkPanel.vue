<!--
  - SPDX-License-Identifier: Apache-2.0
  - Copyright 2026 CasualOffice
  -
  - TALK-01: the Canvas panel in Talk (docs/prototypes/v04-approved/nextcloud-talk.html 2-6).
  - Beside the chat or call (38 rem), a sidebar tab under 64 rem (25 rem), full screen with Talk's
  - top bar (call controls) kept in reach, full screen with a floating call tile on a phone. Holds a
  - shared canvas or the call's meeting canvas, the moderator menu (guests can edit, lock, follow
  - me, save) and the end-of-call decision. Generic chrome only (LEGAL-01).
  -->
<template>
	<div class="oct" :data-layout="layout" :data-mode="open ? mode : 'closed'">
		<!-- The Canvas button: in Talk's top bar when it is there, floating otherwise. -->
		<portal-button v-if="room && state && !hidden"
			:target="buttonTarget"
			:tick="polls"
			:open="open"
			@toggle="toggle" />

		<section v-if="open"
			class="oct-panel"
			:style="panelStyle"
			role="complementary"
			aria-label="Canvas"
			data-oct-panel
			@keydown.esc="onEsc">
			<header class="oct-head">
				<div v-if="layout === 'sidebar' && mode !== 'full'" class="oct-tabs" role="tablist" aria-label="Talk sidebar">
					<span class="oct-tab" role="tab" aria-selected="true">Canvas</span>
				</div>
				<div class="oct-title">
					<NcIconSvgWrapper :svg="icons.layoutDashboard" :size="18" />
					<span class="oct-name" data-oct-title>{{ title }}</span>
					<span v-if="pillInfo" class="oct-pill" :data-tone="pillInfo.tone" data-oct-pill>{{ pillInfo.text }}</span>
				</div>
				<div class="oct-actions">
					<NcActions v-if="canvas" :aria-label="'Canvas menu'" data-oct-menu>
						<template v-if="meeting">
							<NcActionCheckbox v-if="isModerator"
								:checked="meeting.guestsCanEdit"
								:disabled="!meeting.canModerate"
								data-oct-guests
								@update:checked="(v) => options({ guestsCanEdit: v })">
								Guests can edit
							</NcActionCheckbox>
							<NcActionCheckbox v-if="isModerator"
								:checked="meeting.locked"
								:disabled="!meeting.canModerate"
								data-oct-lock
								@update:checked="(v) => options({ locked: v })">
								Lock canvas
							</NcActionCheckbox>
						</template>
						<NcActionCheckbox v-if="isModerator"
							:checked="following"
							data-oct-follow
							@update:checked="toggleFollow">
							Follow me
						</NcActionCheckbox>
						<template v-if="meeting">
							<NcActionButton :disabled="!meeting.canSave" data-oct-save @click="askDecision = true">
								<template #icon>
									<NcIconSvgWrapper :svg="icons.save" :size="18" />
								</template>
								{{ meeting.canSave ? 'Save to Files' : saveReason }}
							</NcActionButton>
							<NcActionButton :disabled="!meeting.canDownload" data-oct-download @click="download">
								<template #icon>
									<NcIconSvgWrapper :svg="icons.download" :size="18" />
								</template>
								{{ meeting.canDownload ? 'Download' : "Guests can't download" }}
							</NcActionButton>
						</template>
					</NcActions>
					<NcButton v-if="layout !== 'phone'"
						type="tertiary"
						:aria-label="mode === 'full' ? 'Exit full screen' : 'Full screen'"
						data-oct-full
						@click="setMode(mode === 'full' ? 'beside' : 'full')">
						<template #icon>
							<NcIconSvgWrapper :svg="mode === 'full' ? icons.minimize2 : icons.maximize2" :size="18" />
						</template>
					</NcButton>
					<NcButton type="tertiary" aria-label="Close canvas" data-oct-close @click="close">
						<template #icon>
							<NcIconSvgWrapper :svg="icons.x" :size="18" />
						</template>
					</NcButton>
				</div>
			</header>

			<div v-if="bannerInfo && canvas && canvas.kind === 'meeting'"
				class="oct-banner"
				:data-kind="bannerInfo.kind"
				role="status"
				data-oct-banner>
				<NcIconSvgWrapper :svg="bannerInfo.kind === 'open' ? icons.circleCheck : icons.clock" :size="16" />
				<span>{{ bannerInfo.text }}</span>
				<NcButton v-if="bannerInfo.kind === 'save' && meeting && meeting.canSave" type="secondary" data-oct-banner-save @click="askDecision = true">
					Save to Files
				</NcButton>
				<NcButton v-if="bannerInfo.kind === 'decide'" type="primary" @click="askDecision = true">
					Decide
				</NcButton>
				<NcButton v-if="bannerInfo.kind === 'open' && meeting && meeting.savedFileId" type="secondary" data-oct-open-saved @click="openFile(meeting.savedFileId, '')">
					Open
				</NcButton>
			</div>

			<div class="oct-body">
				<!-- 5b -->
				<div v-if="error" class="oct-state" data-oct-error>
					<NcEmptyContent :name="error.title" :description="error.description">
						<template #icon>
							<NcIconSvgWrapper :svg="icons.triangleAlert" :size="48" />
						</template>
						<template #action>
							<div class="oct-row">
								<NcButton type="primary" data-oct-retry @click="retry">
									Retry
								</NcButton>
								<NcButton type="tertiary" data-oct-copy @click="copyError">
									Copy error {{ error.code }}
								</NcButton>
							</div>
							<p v-if="error.hint" class="oct-hint">
								{{ error.hint }}
							</p>
						</template>
					</NcEmptyContent>
				</div>

				<CanvasFrame v-else-if="canvas"
					ref="frame"
					:key="canvas.key"
					:fetch-launch="fetchLaunch"
					:display-name="title"
					surface="talk"
					@loaded="onLoaded"
					@error="onFrameError"
					@close="close"
					@view-block="onViewBlock"
					@open-file="(id) => openFile(id, '')" />

				<!-- 3a: a new meeting canvas, or one shared in this conversation -->
				<div v-else-if="choices" class="oct-choose" data-oct-chooser>
					<h3 class="oct-h">
						Canvas for this {{ state.callActive ? 'call' : 'conversation' }}
					</h3>
					<button v-if="state.callActive && state.canStart"
						class="oct-choice"
						data-oct-new
						@click="start">
						<NcIconSvgWrapper :svg="icons.plus" :size="20" />
						<span>
							<strong>New meeting canvas</strong>
							<span class="oct-sub">Everyone in the call can edit. Deleted when the call ends unless a moderator saves it to Files.</span>
						</span>
					</button>
					<p v-else-if="state.callActive && !state.canStart && state.who !== 'guest'" class="oct-sub" data-oct-only-mods>
						Only moderators can start a meeting canvas in this conversation.
					</p>
					<button v-for="c in shared"
						:key="c.fileId"
						class="oct-choice"
						data-oct-shared
						@click="openFile(c.fileId, c.title)">
						<NcIconSvgWrapper :svg="icons.fileText" :size="20" />
						<span>
							<strong>{{ c.title || 'Shared canvas' }}</strong>
							<span class="oct-sub">Shared in this conversation{{ c.by ? ' by ' + c.by : '' }}</span>
						</span>
					</button>
					<NcCheckboxRadioSwitch v-if="isModerator"
						type="switch"
						:checked="state.participantsCanStart"
						data-oct-start-setting
						@update:checked="setStartSetting">
						Participants can start a canvas
					</NcCheckboxRadioSwitch>
				</div>

				<!-- 5a -->
				<div v-else class="oct-state" data-oct-empty>
					<NcEmptyContent name="No canvases here yet" description="Share a canvas from Files, or start a meeting canvas during a call.">
						<template #icon>
							<NcIconSvgWrapper :svg="icons.layoutDashboard" :size="48" />
						</template>
						<template v-if="emptyAct" #action>
							<NcButton type="primary" data-oct-empty-action @click="emptyAct.id === 'start' ? start() : goFiles()">
								{{ emptyAct.label }}
							</NcButton>
						</template>
					</NcEmptyContent>
				</div>
			</div>
		</section>

		<!-- 6b: the call as a floating tile over the full-screen canvas on a phone -->
		<button v-if="open && layout === 'phone' && state && state.callActive"
			class="oct-tile"
			:style="{ left: tile.x + 'px', top: tile.y + 'px' }"
			aria-label="Back to the call"
			data-oct-tile
			@pointerdown="dragStart"
			@click="tileClick">
			<NcIconSvgWrapper :svg="icons.phone" :size="20" />
			<span>{{ state.conversation }}</span>
		</button>

		<!-- 3c: the moderator decides (a bottom sheet on a phone) -->
		<NcDialog v-if="showDecision"
			:name="meeting && meeting.state === 'ended' ? 'Keep the meeting canvas?' : 'Save the meeting canvas?'"
			:class="{ 'oct-sheet': layout === 'phone' }"
			data-oct-decide
			@closing="askDecision = false">
			<p v-if="meeting.state === 'ended'">
				The call has ended. The meeting canvas is deleted unless you save it.
				<span v-if="minutes">It will be discarded in {{ minutes }} min.</span>
			</p>
			<p class="oct-where">
				<NcIconSvgWrapper :svg="icons.folderOpen" :size="16" />
				Save to Talk / {{ state.conversation }}
			</p>
			<NcCheckboxRadioSwitch :checked.sync="postBack" data-oct-post-back>
				Post it to {{ state.conversation }}
			</NcCheckboxRadioSwitch>
			<template #actions>
				<NcButton type="tertiary" data-oct-discard @click="decideNow('discard')">
					Discard
				</NcButton>
				<NcButton type="primary" data-oct-save-files @click="decideNow('save')">
					Save to Files
				</NcButton>
			</template>
		</NcDialog>
	</div>
</template>

<script>
import NcActions from '@nextcloud/vue/dist/Components/NcActions.js'
import NcActionButton from '@nextcloud/vue/dist/Components/NcActionButton.js'
import NcActionCheckbox from '@nextcloud/vue/dist/Components/NcActionCheckbox.js'
import NcButton from '@nextcloud/vue/dist/Components/NcButton.js'
import NcCheckboxRadioSwitch from '@nextcloud/vue/dist/Components/NcCheckboxRadioSwitch.js'
import NcDialog from '@nextcloud/vue/dist/Components/NcDialog.js'
import NcEmptyContent from '@nextcloud/vue/dist/Components/NcEmptyContent.js'
import NcIconSvgWrapper from '@nextcloud/vue/dist/Components/NcIconSvgWrapper.js'
import { showError, showInfo, showSuccess } from '@nextcloud/dialogs'
import { generateUrl } from '@nextcloud/router'
import CanvasFrame from '../components/CanvasFrame.vue'
import PortalButton from './PortalButton.vue'
import * as icons from './icons.js'
import * as api from './api.js'
import { userLaunch } from '../lib/launch.js'
import { banner, emptyAction, followTarget, layoutFor, minutesLeft, openError, pill, roomFromPath } from './model.js'

const POLL_OPEN_MS = 2000
const POLL_CLOSED_MS = 5000

export default {
	name: 'TalkPanel',
	components: { CanvasFrame, NcActions, NcActionButton, NcActionCheckbox, NcButton, NcCheckboxRadioSwitch, NcDialog, NcEmptyContent, NcIconSvgWrapper, PortalButton },
	data() {
		return {
			icons,
			room: null,
			state: null,
			open: false,
			mode: 'beside',
			layout: 'beside',
			canvas: null,
			shared: [],
			choices: false,
			error: null,
			failures: 0,
			askDecision: false,
			decidedFor: 0,
			postBack: true,
			lastFollow: null,
			lastMeetingState: null,
			timer: 0,
			buttonTarget: null,
			hidden: false,
			now: Date.now(),
			tile: { x: 16, y: 80 },
			dragged: false,
			polls: 0,
			topOffset: 0,
		}
	},
	computed: {
		meeting() {
			return this.canvas?.kind === 'meeting' ? this.state?.meeting : null
		},
		isModerator() {
			return this.state?.who === 'moderator'
		},
		pillInfo() {
			return this.meeting ? pill(this.meeting, this.state.who) : null
		},
		bannerInfo() {
			return this.state?.meeting ? banner(this.state.meeting, this.state.who) : null
		},
		title() {
			if (this.canvas?.kind === 'meeting') {
				return 'Meeting canvas'
			}
			return this.canvas?.title || 'Canvas'
		},
		canvasKey() {
			return this.canvas ? (this.canvas.kind === 'meeting' ? `m:${this.canvas.id}` : `f:${this.canvas.fileId}`) : ''
		},
		following() {
			return !!this.state?.follow && this.state.follow.by === this.state.me?.id && this.state.follow.canvas === this.canvasKey
		},
		saveReason() {
			return this.state?.who === 'guest' ? "Guests can't save" : 'Only a moderator can save'
		},
		emptyAct() {
			return emptyAction(this.state)
		},
		minutes() {
			return minutesLeft(this.meeting?.discardAt, this.now)
		},
		showDecision() {
			const m = this.state?.meeting
			if (!m || this.state.who !== 'moderator' || !m.canSave) {
				return false
			}
			// 3c: asked once when the call ends (even with the panel closed), or from Save to Files.
			return this.askDecision || (m.state === 'ended' && this.decidedFor !== m.id)
		},
		panelStyle() {
			return this.mode === 'full' || this.layout === 'phone' ? { top: this.topOffset + 'px' } : {}
		},
	},
	watch: {
		open() {
			this.applyLayout()
		},
		mode() {
			this.applyLayout()
		},
	},
	mounted() {
		window.addEventListener('resize', this.onResize)
		window.addEventListener('opencanvas:open', this.onCardOpen)
		this.onResize()
		this.tick()
	},
	beforeDestroy() {
		window.removeEventListener('resize', this.onResize)
		window.removeEventListener('opencanvas:open', this.onCardOpen)
		clearTimeout(this.timer)
		document.body.classList.remove('oct-beside', 'oct-sidebar')
	},
	methods: {
		async tick() {
			clearTimeout(this.timer)
			const room = roomFromPath(window.location.pathname)
			if (room !== this.room) {
				this.room = room
				this.state = null
				this.close()
			}
			// Talk 21: the call button's group in the conversation's top bar.
			this.buttonTarget = document.querySelector('.top-bar .top-bar-menu, .top-bar__buttons') ?? null
			this.polls++
			if (this.room) {
				try {
					this.state = await api.getState(this.room)
					this.hidden = false
					this.react()
				} catch (e) {
					// Not a participant, Talk off, or the app not reachable: no button.
					this.hidden = true
				}
			}
			this.now = Date.now()
			this.timer = setTimeout(this.tick, this.open ? POLL_OPEN_MS : POLL_CLOSED_MS)
		},
		/** Reacts to the meeting's state and Follow me after every poll. */
		react() {
			const m = this.state.meeting
			const key = m ? `${m.id}:${m.state}` : null
			if (key !== this.lastMeetingState) {
				const prev = this.lastMeetingState
				this.lastMeetingState = key
				if (m && this.canvas?.kind === 'meeting' && this.canvas.id === m.id) {
					// Editing stops at once when the call ends (the server also lowers the role).
					this.$refs.frame?.post('Action_SetReadOnly', { readOnly: m.role !== 'edit' })
					if (m.state === 'discarded' && prev) {
						showInfo('The meeting canvas was discarded.')
						this.close()
					}
				}
			}
			const target = followTarget(this.state.follow, this.state.me?.id, this.canvasKey, this.lastFollow)
			if (target) {
				this.lastFollow = target
				this.$refs.frame?.post('Action_ScrollToBlock', { blockId: target, follow: true })
			}
		},
		onResize() {
			const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
			this.layout = layoutFor(window.innerWidth, rem)
			this.applyLayout()
		},
		applyLayout() {
			const header = document.querySelector('#header')
			const bar = document.querySelector('.top-bar')
			// Full screen keeps Talk's top bar (with the call controls) in reach (2b).
			this.topOffset = this.mode === 'full' ? (bar?.getBoundingClientRect().bottom ?? header?.offsetHeight ?? 0) : 0
			document.body.classList.toggle('oct-beside', this.open && this.mode !== 'full' && this.layout === 'beside')
			document.body.classList.toggle('oct-sidebar', this.open && this.mode !== 'full' && this.layout === 'sidebar')
		},
		toggle() {
			if (this.open) {
				this.close()
			} else {
				this.show()
			}
		},
		async show() {
			this.open = true
			this.mode = this.layout === 'phone' ? 'full' : 'beside'
			const m = this.state?.meeting
			if (m && (m.state === 'active' || m.state === 'ended')) {
				this.openMeeting(m.id)
				return
			}
			this.canvas = null
			try {
				this.shared = this.state?.who === 'guest' ? [] : await api.sharedCanvases(this.room)
			} catch (e) {
				this.shared = []
			}
			this.choices = !!(this.shared.length || (this.state?.callActive && this.state?.canStart) || this.isModerator && this.state?.callActive)
		},
		close() {
			if (this.following) {
				api.setFollow(this.room, '', false).catch(() => {})
			}
			this.open = false
			this.canvas = null
			this.error = null
			this.choices = false
		},
		onEsc() {
			if (this.mode === 'full' && this.layout !== 'phone') {
				this.setMode('beside')
			}
		},
		setMode(m) {
			this.mode = m
		},
		openMeeting(id) {
			this.error = null
			this.failures = 0
			this.lastFollow = null
			this.canvas = { kind: 'meeting', id, key: `m${id}-${Date.now()}` }
		},
		openFile(fileId, title) {
			this.error = null
			this.failures = 0
			this.lastFollow = null
			this.open = true
			this.canvas = { kind: 'file', fileId: Number(fileId), title, key: `f${fileId}-${Date.now()}` }
		},
		onCardOpen(e) {
			const d = e.detail ?? {}
			if (!d.fileId) {
				return
			}
			this.mode = d.mode === 'full' || this.layout === 'phone' ? 'full' : 'beside'
			this.openFile(d.fileId, d.title ?? '')
		},
		async fetchLaunch() {
			if (this.canvas.kind === 'meeting') {
				return api.meetingLaunch(this.room, this.canvas.id)
			}
			const data = await userLaunch(this.canvas.fileId)
			if (data.name && !this.canvas.title) {
				this.canvas.title = data.name.replace(/\.ocanvas$/i, '')
			}
			return data
		},
		onLoaded() {
			this.failures = 0
			if (this.following) {
				this.$refs.frame?.post('Action_FollowView', { on: true })
			}
			if (this.meeting && this.meeting.role !== 'edit') {
				this.$refs.frame?.post('Action_SetReadOnly', { readOnly: true })
			}
		},
		onFrameError(code) {
			this.failures++
			this.error = openError(code, this.failures, null)
		},
		retry() {
			this.error = null
			this.canvas = { ...this.canvas, key: `${this.canvas.kind}-${Date.now()}` }
		},
		async copyError() {
			try {
				await navigator.clipboard.writeText(this.error.code)
				showSuccess('Error code copied')
			} catch (e) {
				showError(this.error.code)
			}
		},
		async start() {
			try {
				const { id } = await api.startMeeting(this.room)
				this.state = await api.getState(this.room)
				this.openMeeting(id)
			} catch (e) {
				const code = e?.response?.data?.error
				showError(code === 'FORBIDDEN' ? 'Only moderators can start a meeting canvas here.' : code === 'NO_CALL' ? 'Start or join the call first.' : "The meeting canvas couldn't start.")
			}
		},
		async options(opts) {
			try {
				await api.setOptions(this.room, this.meeting.id, opts)
				this.state = await api.getState(this.room)
			} catch (e) {
				showError("That didn't work. Try again.")
			}
		},
		async setStartSetting(on) {
			await api.setParticipantsCanStart(this.room, on)
			this.state = await api.getState(this.room)
		},
		async toggleFollow(on) {
			await api.setFollow(this.room, this.canvasKey, on)
			this.$refs.frame?.post('Action_FollowView', { on })
			this.state = await api.getState(this.room)
		},
		onViewBlock(blockId) {
			if (this.following) {
				api.followView(this.room, blockId).catch(() => {})
			}
		},
		async decideNow(action) {
			const m = this.state.meeting
			this.askDecision = false
			this.decidedFor = m.id
			try {
				const r = await api.decide(this.room, m.id, action, this.postBack)
				if (action === 'save') {
					showSuccess(this.postBack ? `Saved to Talk / ${this.state.conversation} and posted` : `Saved to Talk / ${this.state.conversation}`)
				} else {
					showInfo('The meeting canvas was discarded.')
					this.close()
				}
				this.state = await api.getState(this.room)
				return r
			} catch (e) {
				showError("The meeting canvas couldn't be saved. Try again.")
				this.decidedFor = 0
			}
		},
		download() {
			this.$refs.frame?.post('Action_Export', { format: 'ocanvas' })
		},
		goFiles() {
			window.location.href = generateUrl('/apps/files/')
		},
		dragStart(e) {
			const sx = e.clientX - this.tile.x
			const sy = e.clientY - this.tile.y
			let moved = false
			const move = (ev) => {
				moved = true
				this.tile = { x: Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - sx)), y: Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - sy)) }
			}
			const up = () => {
				window.removeEventListener('pointermove', move)
				window.removeEventListener('pointerup', up)
				this.dragged = moved
			}
			window.addEventListener('pointermove', move)
			window.addEventListener('pointerup', up)
		},
		tileClick() {
			if (this.dragged) {
				this.dragged = false
				return
			}
			// Back to the call: the canvas keeps its place behind the Canvas button.
			this.open = false
		},
	},
}
</script>

<style>
body.oct-beside #content-vue,
body.oct-beside #content {
	margin-inline-end: 38rem;
}
body.oct-sidebar #content-vue,
body.oct-sidebar #content {
	margin-inline-end: 25rem;
}
</style>

<style scoped>
.oct-panel {
	position: fixed;
	inset-block: var(--header-height, 3.125rem) 0;
	inset-inline-end: 0;
	width: 38rem;
	max-width: 100vw;
	display: flex;
	flex-direction: column;
	background: var(--color-main-background);
	border-inline-start: 1px solid var(--color-border);
	z-index: 2000;
}
[data-layout='sidebar'] .oct-panel {
	width: 25rem;
}
[data-mode='full'] .oct-panel,
[data-layout='phone'] .oct-panel {
	width: auto;
	inset-inline-start: 0;
	border: 0;
}
[data-layout='phone'] .oct-panel {
	inset-block-start: 0 !important;
}
.oct-head {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	padding: 0.375rem 0.5rem 0.375rem 0.75rem;
	border-block-end: 1px solid var(--color-border);
	min-height: 3.25rem;
	flex-wrap: wrap;
}
.oct-tabs {
	flex-basis: 100%;
	display: flex;
}
.oct-tab {
	padding: 0.25rem 0.75rem;
	border-block-end: 0.125rem solid var(--color-primary-element);
	font-weight: 600;
}
.oct-title {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	min-width: 0;
	flex: 1;
}
.oct-name {
	font-weight: 600;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.oct-pill {
	padding: 0.125rem 0.5rem;
	border-radius: 1rem;
	font-size: 0.8125rem;
	background: var(--color-background-dark);
	color: var(--color-main-text);
	white-space: nowrap;
}
.oct-pill[data-tone='amber'] {
	background: var(--color-warning);
	color: var(--color-warning-text, #000);
}
.oct-actions {
	display: flex;
	align-items: center;
	gap: 0.125rem;
}
.oct-banner {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	padding: 0.5rem 0.75rem;
	background: var(--color-background-hover);
	border-block-end: 1px solid var(--color-border);
	font-size: 0.875rem;
}
.oct-banner span {
	flex: 1;
}
.oct-banner[data-kind='save'],
.oct-banner[data-kind='decide'],
.oct-banner[data-kind='wait'] {
	background: color-mix(in srgb, var(--color-warning) 18%, var(--color-main-background));
}
.oct-body {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
	overflow: auto;
}
.oct-body > :deep(.oc-frame) {
	flex: 1;
	min-height: 0;
}
.oct-state {
	margin: auto;
	padding: 1rem;
	text-align: center;
}
.oct-row {
	display: flex;
	gap: 0.5rem;
	justify-content: center;
	flex-wrap: wrap;
}
.oct-hint,
.oct-sub {
	color: var(--color-text-maxcontrast);
	font-size: 0.875rem;
	display: block;
	font-weight: normal;
}
.oct-choose {
	padding: 1rem;
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
}
.oct-h {
	margin: 0 0 0.25rem;
	font-size: 1rem;
}
.oct-choice {
	display: flex;
	gap: 0.75rem;
	align-items: flex-start;
	text-align: start;
	padding: 0.75rem;
	min-height: 2.75rem;
	border: 1px solid var(--color-border);
	border-radius: var(--border-radius-large, 0.75rem);
	background: var(--color-main-background);
	color: var(--color-main-text);
	cursor: pointer;
}
.oct-choice:hover,
.oct-choice:focus-visible {
	background: var(--color-background-hover);
}
.oct-tile {
	position: fixed;
	z-index: 2100;
	display: flex;
	align-items: center;
	gap: 0.5rem;
	min-height: 2.75rem;
	min-width: 2.75rem;
	padding: 0.5rem 0.75rem;
	border: 0;
	border-radius: 1.5rem;
	background: var(--color-primary-element);
	color: var(--color-primary-element-text);
	box-shadow: 0 0.25rem 1rem rgba(0, 0, 0, 0.25);
	touch-action: none;
}
.oct-where {
	display: flex;
	align-items: center;
	gap: 0.375rem;
	color: var(--color-text-maxcontrast);
}
</style>
