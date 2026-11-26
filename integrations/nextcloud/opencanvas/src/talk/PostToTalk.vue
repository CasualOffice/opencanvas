<!--
  - SPDX-License-Identifier: Apache-2.0
  - Copyright 2026 CasualOffice
  -
  - TALK-01 1a: "Post to a Talk conversation". Pick a conversation you are in, add an optional
  - message, and post the canvas as a card. If people there can't open it, say how many and offer
  - to share the file with the conversation in the same step. Posting alone never grants access.
  -->
<template>
	<NcDialog name="Post to a Talk conversation" size="normal" data-oct-post @closing="$emit('close')">
		<NcTextField :value.sync="query" label="Search conversations" data-oct-post-search />
		<ul class="opt-list" role="listbox" aria-label="Conversations">
			<li v-for="c in filtered"
				:key="c.token"
				role="option"
				:aria-selected="c.token === room ? 'true' : 'false'"
				class="opt-item"
				:class="{ 'opt-item--on': c.token === room }"
				tabindex="0"
				:data-oct-room="c.token"
				@click="pick(c.token)"
				@keydown.enter.prevent="pick(c.token)">
				<strong>{{ c.name }}</strong>
				<span v-if="c.participants" class="opt-sub">{{ c.participants }} participants</span>
			</li>
			<li v-if="!filtered.length" class="opt-sub">
				{{ loading ? 'Loading conversations…' : 'No conversations found' }}
			</li>
		</ul>
		<NcTextArea :value.sync="message" label="Message (optional)" placeholder="Shared the plan, have a look" data-oct-post-message />
		<div v-if="missingLine" class="opt-access" data-oct-post-missing>
			<p>{{ missingLine }}</p>
			<NcCheckboxRadioSwitch :checked.sync="shareIt" data-oct-post-share>
				Share the file with the conversation
			</NcCheckboxRadioSwitch>
			<NcCheckboxRadioSwitch v-if="shareIt"
				type="radio"
				name="oct-level"
				value="edit"
				:checked.sync="level">
				Can edit
			</NcCheckboxRadioSwitch>
			<NcCheckboxRadioSwitch v-if="shareIt"
				type="radio"
				name="oct-level"
				value="view"
				:checked.sync="level">
				Can view
			</NcCheckboxRadioSwitch>
		</div>
		<template #actions>
			<NcButton type="tertiary" @click="$emit('close')">
				Cancel
			</NcButton>
			<NcButton type="primary" :disabled="!room || !link || busy" data-oct-post-go @click="post">
				Post
			</NcButton>
		</template>
	</NcDialog>
</template>

<script>
import NcButton from '@nextcloud/vue/dist/Components/NcButton.js'
import NcCheckboxRadioSwitch from '@nextcloud/vue/dist/Components/NcCheckboxRadioSwitch.js'
import NcDialog from '@nextcloud/vue/dist/Components/NcDialog.js'
import NcTextArea from '@nextcloud/vue/dist/Components/NcTextArea.js'
import NcTextField from '@nextcloud/vue/dist/Components/NcTextField.js'
import { showError, showSuccess } from '@nextcloud/dialogs'
import { accessFor, conversations, postMessage, shareToRoom } from './api.js'
import { missingText } from './model.js'

export default {
	name: 'PostToTalk',
	components: { NcButton, NcCheckboxRadioSwitch, NcDialog, NcTextArea, NcTextField },
	props: {
		fileId: { type: Number, required: true },
	},
	emits: ['close'],
	data: () => ({ all: [], query: '', room: '', message: '', link: '', missing: 0, total: 0, shareIt: false, level: 'edit', busy: false, loading: true }),
	computed: {
		filtered() {
			const q = this.query.trim().toLowerCase()
			return this.all.filter((c) => !q || c.name.toLowerCase().includes(q)).slice(0, 50)
		},
		missingLine() {
			return missingText(this.missing, this.total)
		},
	},
	async mounted() {
		try {
			this.all = await conversations()
		} catch (e) {
			showError("Talk conversations couldn't be loaded.")
		}
		this.loading = false
	},
	methods: {
		async pick(token) {
			this.room = token
			this.link = ''
			try {
				const a = await accessFor(token, this.fileId)
				this.link = a.link
				this.missing = a.missing
				this.total = a.total
				this.shareIt = false
			} catch (e) {
				showError("This canvas can't be posted there.")
			}
		},
		async post() {
			this.busy = true
			try {
				if (this.shareIt) {
					await shareToRoom(this.room, this.fileId, this.level)
				}
				const text = this.message.trim()
				await postMessage(this.room, text ? `${text}\n${this.link}` : this.link)
				showSuccess('Posted to the conversation')
				this.$emit('close')
			} catch (e) {
				showError("The canvas couldn't be posted.")
			}
			this.busy = false
		},
	},
}
</script>

<style scoped>
.opt-list {
	list-style: none;
	margin: 0.5rem 0;
	padding: 0;
	max-height: 14rem;
	overflow: auto;
}
.opt-item {
	display: flex;
	flex-direction: column;
	padding: 0.5rem 0.75rem;
	min-height: 2.75rem;
	border-radius: var(--border-radius-large, 0.75rem);
	cursor: pointer;
}
.opt-item:hover,
.opt-item:focus-visible,
.opt-item--on {
	background: var(--color-primary-element-light, var(--color-background-hover));
}
.opt-sub {
	color: var(--color-text-maxcontrast);
	font-size: 0.875rem;
}
.opt-access {
	margin-top: 0.75rem;
	padding: 0.5rem 0.75rem;
	border-radius: var(--border-radius-large, 0.75rem);
	background: color-mix(in srgb, var(--color-warning) 15%, var(--color-main-background));
}
.opt-access p {
	margin: 0;
}
</style>
