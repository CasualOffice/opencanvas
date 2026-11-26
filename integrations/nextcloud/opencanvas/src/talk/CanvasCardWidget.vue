<!--
  - SPDX-License-Identifier: Apache-2.0
  - Copyright 2026 CasualOffice
  -
  - TALK-01 1b / 5c / 6a: the card for a canvas posted to a conversation (the rich object from
  - lib/Reference/CanvasReferenceProvider.php). With access: title, where it lives, two lines of
  - preview, when it was edited, "Open beside chat" and "Full screen" ("Open" on a phone). Without:
  - the title and who shared it, no preview, and "Ask … for access" (a Talk reply to the sharer).
  -->
<template>
	<div class="occ" :data-access="card.access ? 'yes' : 'no'" data-occ-card>
		<div class="occ-head">
			<NcIconSvgWrapper :svg="icon" :size="20" class="occ-icon" />
			<div class="occ-titles">
				<a v-if="card.access"
					class="occ-title"
					href="#"
					data-occ-title
					@click.prevent="open('full')">{{ card.title }}</a>
				<span v-else class="occ-title" data-occ-title>{{ card.title }}</span>
				<span class="occ-where">OpenCanvas<template v-if="card.access"> · {{ card.where }}</template></span>
			</div>
		</div>
		<template v-if="card.access">
			<p v-for="(l, i) in card.preview" :key="i" class="occ-line" :class="{ 'occ-line--first': i === 0 }">
				{{ l }}
			</p>
			<p v-if="edited" class="occ-meta">
				Edited {{ edited }}
			</p>
			<div class="occ-actions">
				<NcButton v-if="!phone" type="secondary" data-occ-beside @click="open('beside')">
					Open beside chat
				</NcButton>
				<NcButton :type="phone ? 'secondary' : 'tertiary'" data-occ-full @click="open('full')">
					{{ phone ? 'Open' : 'Full screen' }}
				</NcButton>
			</div>
		</template>
		<template v-else>
			<p class="occ-line" data-occ-noaccess>
				You don't have access to this canvas.<template v-if="card.sharer"> {{ card.sharer }} shared it with the conversation, but the file isn't shared with you.</template>
			</p>
			<div v-if="card.by && room" class="occ-actions">
				<NcButton type="secondary" :disabled="asked" data-occ-ask @click="ask">
					{{ asked ? 'Asked' : `Ask ${card.sharer || 'the sharer'} for access` }}
				</NcButton>
			</div>
		</template>
	</div>
</template>

<script>
import NcButton from '@nextcloud/vue/dist/Components/NcButton.js'
import NcIconSvgWrapper from '@nextcloud/vue/dist/Components/NcIconSvgWrapper.js'
import axios from '@nextcloud/axios'
import { showError } from '@nextcloud/dialogs'
import { generateUrl } from '@nextcloud/router'
import { fileText } from './icons.js'
import { postMessage } from './api.js'
import { roomFromPath } from './model.js'

export default {
	name: 'CanvasCardWidget',
	components: { NcButton, NcIconSvgWrapper },
	props: {
		/** The rich object Nextcloud resolved (browser-cached up to an hour). */
		initial: { type: Object, required: true },
	},
	data() {
		return { card: this.initial, icon: fileText, asked: false, phone: window.innerWidth < 720 }
	},
	async mounted() {
		// Ask again for this reader now: access may have changed since the cached answer.
		try {
			const { data } = await axios.get(generateUrl('/apps/opencanvas/talk/card/{fileId}', { fileId: this.initial.fileId }), { params: { by: this.initial.by ?? '' } })
			if (data && typeof data.access === 'boolean') {
				this.card = data
			}
		} catch (e) {
			// Keep the resolved card.
		}
	},
	computed: {
		room() {
			return roomFromPath(window.location.pathname)
		},
		edited() {
			if (!this.card.mtime) {
				return ''
			}
			const s = Math.max(0, Date.now() / 1000 - this.card.mtime)
			if (s < 60) {
				return 'just now'
			}
			if (s < 3600) {
				return `${Math.round(s / 60)} min ago`
			}
			if (s < 86400) {
				return `${Math.round(s / 3600)} h ago`
			}
			return new Date(this.card.mtime * 1000).toLocaleDateString()
		},
	},
	methods: {
		open(mode) {
			if (this.room) {
				window.dispatchEvent(new CustomEvent('opencanvas:open', { detail: { fileId: this.card.fileId, title: this.card.title, mode } }))
			} else {
				window.location.href = `${window.location.origin}${window.OC?.webroot ?? ''}/index.php/apps/opencanvas/open/${this.card.fileId}`
			}
		},
		async ask() {
			try {
				// A Talk message to the sharer, no new permission flow (5c).
				await postMessage(this.room, `@"${this.card.by}" could you share "${this.card.title}" with me? I can't open it yet.`)
				this.asked = true
			} catch (e) {
				showError("The message couldn't be sent.")
			}
		},
	},
}
</script>

<style scoped>
.occ {
	border: 1px solid var(--color-border);
	border-radius: var(--border-radius-large, 0.75rem);
	padding: 0.75rem 0.875rem;
	max-width: 32rem;
	background: var(--color-main-background);
	white-space: normal;
}
.occ-head {
	display: flex;
	gap: 0.625rem;
	align-items: flex-start;
}
.occ-icon {
	color: var(--color-primary-element);
}
.occ-titles {
	display: flex;
	flex-direction: column;
	min-width: 0;
}
.occ-title {
	font-weight: 600;
	color: var(--color-main-text);
}
.occ-where,
.occ-meta {
	color: var(--color-text-maxcontrast);
	font-size: 0.8125rem;
	overflow-wrap: anywhere;
}
.occ-line {
	margin: 0.375rem 0 0;
	overflow: hidden;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
}
.occ-line--first {
	font-weight: 600;
}
.occ-actions {
	display: flex;
	gap: 0.5rem;
	margin-top: 0.625rem;
	flex-wrap: wrap;
}
</style>
