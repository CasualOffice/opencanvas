<!--
  - SPDX-License-Identifier: Apache-2.0
  - Copyright 2026 CasualOffice
  -
  - S7: a guest opens a public link to a canvas. Nextcloud's public page gives the header (name,
  - who shared it, Download) and any password step (S7a). The canvas fills the rest. Edit links ask
  - for a name first (S7b, S7g); view-only links open at once, as "Guest" (S7d, S7h). Links turned
  - off by the admin explain instead of failing (S7f).
  -->
<template>
	<div class="oc-public" data-oc-public>
		<template v-if="info === null">
			<GuestSkeleton />
		</template>
		<template v-else-if="askName">
			<GuestSkeleton />
			<GuestNameDialog :canvas-name="displayName" :initial="guestName" @submit="onName" />
		</template>
		<CanvasFrame v-else
			:fetch-launch="fetchLaunch"
			:display-name="displayName"
			surface="public"
			:can-download="!info.hideDownload"
			:download-url="downloadUrl"
			:owner="info.owner || ''"
			:preset-error="preset" />
	</div>
</template>

<script>
import { generateUrl } from '@nextcloud/router'
import CanvasFrame from '../components/CanvasFrame.vue'
import GuestNameDialog from '../components/GuestNameDialog.vue'
import GuestSkeleton from '../components/GuestSkeleton.vue'
import { codeFromResponse } from '../lib/errors.js'
import { guestLaunch, publicInfo, stripExtension } from '../lib/launch.js'
import { needsGuestName, saveGuestName, savedGuestName } from '../lib/guest.js'

export default {
	name: 'PublicCanvas',
	components: { CanvasFrame, GuestNameDialog, GuestSkeleton },
	props: {
		shareToken: { type: String, required: true },
		fileName: { type: String, default: '' },
	},
	data() {
		return { info: null, preset: null, guestName: savedGuestName(), askName: false }
	},
	computed: {
		displayName() {
			return stripExtension(this.info?.name || this.fileName)
		},
		downloadUrl() {
			return generateUrl('/s/{token}/download', { token: this.shareToken })
		},
	},
	async mounted() {
		try {
			this.info = await publicInfo(this.shareToken)
			if (!this.info.configured) {
				this.preset = { code: 'NOT_CONFIGURED' }
			}
		} catch (e) {
			const res = e?.response
			this.info = { owner: res?.data?.owner ?? '', hideDownload: true }
			this.preset = { code: codeFromResponse(res?.status ?? 0, res?.data) }
			return
		}
		this.askName = needsGuestName(this.info.permissions) && this.guestName === ''
	},
	methods: {
		onName(name) {
			this.guestName = name
			saveGuestName(name)
			this.askName = false
		},
		fetchLaunch() {
			const editor = needsGuestName(this.info.permissions)
			return guestLaunch(this.shareToken, this.info.fileId, editor ? this.guestName : '')
		},
	},
}
</script>

<style scoped>
.oc-public {
	position: relative;
	width: 100%;
	height: 100%;
	min-height: 0;
}
</style>
