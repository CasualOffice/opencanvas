<!--
  - SPDX-License-Identifier: Apache-2.0
  - Copyright 2026 CasualOffice
  -
  - S4: a canvas in Nextcloud's Viewer. The dark bar (name, details, "…", close) is the Viewer's
  - own; everything below it is this component: the spinner (S4a), OpenCanvas (S4b-S4f, S4j-S4m,
  - its own bar and banners) or a Nextcloud error screen (S4g-S4i, S4n). Registered in viewer.js.
  -->
<template>
	<div class="oc-viewer" data-oc-viewer>
		<template v-if="needsName">
			<GuestSkeleton />
			<GuestNameDialog :canvas-name="displayName" :initial="guestName" @submit="onGuestName" />
		</template>
		<CanvasFrame v-else
			:fetch-launch="fetchLaunch"
			:display-name="displayName"
			surface="viewer"
			:is-admin="isAdmin"
			:can-download="canDownload"
			:download-url="downloadUrl"
			@loaded="doneLoading"
			@error="doneLoading"
			@close="close"
			@open-file="openFile" />
	</div>
</template>

<script>
import { getCurrentUser } from '@nextcloud/auth'
import { generateUrl, generateRemoteUrl } from '@nextcloud/router'
import { getSharingToken, isPublicShare } from '@nextcloud/sharing/public'
import { loadState } from '@nextcloud/initial-state'
import CanvasFrame from '../components/CanvasFrame.vue'
import GuestNameDialog from '../components/GuestNameDialog.vue'
import GuestSkeleton from '../components/GuestSkeleton.vue'
import { guestLaunch, stripExtension, userLaunch } from '../lib/launch.js'
import { needsGuestName, saveGuestName, savedGuestName } from '../lib/guest.js'

export default {
	name: 'ViewerCanvas',
	components: { CanvasFrame, GuestNameDialog, GuestSkeleton },
	props: {
		fileid: { type: Number, default: null },
		basename: { type: String, default: '' },
		filename: { type: String, default: '' },
		source: { type: String, default: '' },
		davPath: { type: String, default: '' },
		permissions: { type: String, default: '' },
		active: { type: Boolean, default: false },
		loaded: { type: Boolean, default: false },
	},
	emits: ['update:loaded'],
	data() {
		const guest = isPublicShare()
		const perms = guest ? loadState('files_sharing', 'sharePermissions', 1) : 0
		const name = guest ? savedGuestName() : ''
		return {
			guest,
			guestName: name,
			needsName: guest && needsGuestName(perms) && name === '',
		}
	},
	computed: {
		displayName() {
			return stripExtension(this.basename)
		},
		isAdmin() {
			return !!getCurrentUser()?.isAdmin
		},
		canDownload() {
			// The Viewer hides its own Download when the share forbids it; the same goes for ours.
			return !this.guest || loadState('files_sharing', 'hideDownload', false) === false
		},
		downloadUrl() {
			if (this.source) {
				return this.source
			}
			return this.davPath || generateRemoteUrl('dav') + `/files/${getCurrentUser()?.uid}${this.filename}`
		},
	},
	mounted() {
		// Nextcloud 31's Viewer keeps a header-high gap under its content for images; a canvas uses
		// the full height under the Viewer bar.
		this.$el.closest('.viewer__file-wrapper')?.classList.add('oc-viewer-wrapper')
		this.$el.closest('.modal-container')?.classList.add('oc-viewer-container')
	},
	beforeDestroy() {
		this.$el.closest('.modal-container')?.classList.remove('oc-viewer-container')
	},
	methods: {
		fetchLaunch() {
			return this.guest
				? guestLaunch(getSharingToken(), this.fileid, this.guestName)
				: userLaunch(this.fileid)
		},
		onGuestName(name) {
			this.guestName = name
			saveGuestName(name)
			this.needsName = false
		},
		doneLoading() {
			this.$emit('update:loaded', true)
		},
		close() {
			window.OCA?.Viewer?.close()
		},
		openFile(fileId) {
			// S4l "Open the copy": the conflict copy sits next to the original.
			window.OCA?.Viewer?.close()
			window.location.href = generateUrl('/f/{fileId}', { fileId })
		},
	},
}
</script>

<style scoped>
.oc-viewer {
	position: relative;
	width: 100%;
	height: 100%;
	min-height: 0;
}
</style>

<style>
/* Unscoped: the Viewer's wrapper around a handler (Nextcloud 30-32). */
.modal-container.oc-viewer-container {
	bottom: 0 !important;
}
.viewer__file-wrapper.oc-viewer-wrapper {
	width: 100% !important;
	height: 100% !important;
	align-items: stretch !important;
}
.viewer__file-wrapper.oc-viewer-wrapper > .oc-viewer {
	flex: 1 1 auto;
}
</style>
