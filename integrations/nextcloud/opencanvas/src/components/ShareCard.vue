<!--
  - SPDX-License-Identifier: Apache-2.0
  - Copyright 2026 CasualOffice
  -
  - S8a: what each Nextcloud share level means inside a canvas. Nextcloud's own controls are
  - unchanged; this card sits under the shares.
  -->
<template>
	<div class="oc-card" data-oc-share-card>
		<div class="oc-card__head">
			<NcIconSvgWrapper :svg="icon" :size="18" />
			<span>What this means in a canvas</span>
		</div>
		<dl class="oc-card__grid">
			<dt>Can edit</dt>
			<dd>Write, add pages, change databases and whiteboards.</dd>
			<dt>View only</dt>
			<dd>Read and see others' edits live. No changes.</dd>
			<template v-if="commentRole">
				<dt>Can comment</dt>
				<dd>View only, plus comments (an option in the share's advanced settings).</dd>
			</template>
			<dt>No download</dt>
			<dd>Editing as above, but no export, print or download.</dd>
		</dl>
		<NcButton v-if="talk && fileId" type="secondary" wide data-oc-post-talk @click="posting = true">
			Post to a Talk conversation
		</NcButton>
		<PostToTalk v-if="posting" :file-id="fileId" @close="posting = false" />
	</div>
</template>

<script>
import NcButton from '@nextcloud/vue/dist/Components/NcButton.js'
import NcIconSvgWrapper from '@nextcloud/vue/dist/Components/NcIconSvgWrapper.js'
import { getCapabilities } from '@nextcloud/capabilities'
import { ocanvas } from '../icons.js'

export default {
	name: 'ShareCard',
	components: {
		NcButton,
		NcIconSvgWrapper,
		// TALK-01 1a, loaded only when used.
		PostToTalk: () => import('../talk/PostToTalk.vue'),
	},
	props: {
		commentRole: { type: Boolean, default: false },
		fileId: { type: Number, default: 0 },
	},
	data: () => ({ icon: ocanvas, posting: false, talk: !!getCapabilities()?.spreed }),
}
</script>

<style scoped>
.oc-card {
	margin-top: 12px;
	border: 1px solid var(--color-border);
	border-radius: var(--border-radius-large, 12px);
	padding: 12px 14px;
	font-size: 13.5px;
	line-height: 1.5;
}
.oc-card__head {
	display: flex;
	gap: 8px;
	align-items: center;
	font-weight: 600;
	margin-bottom: 6px;
}
.oc-card__grid {
	display: grid;
	grid-template-columns: auto 1fr;
	gap: 4px 10px;
	margin: 0;
	color: var(--color-text-maxcontrast);
}
.oc-card__grid dt {
	color: var(--color-main-text);
	font-weight: 600;
}
.oc-card__grid dd {
	margin: 0;
}
</style>
