<!--
  - SPDX-License-Identifier: Apache-2.0
  - Copyright 2026 CasualOffice
  -
  - S7b/S7g: guests on edit links give a name first, so others know who is typing.
  -->
<template>
	<NcDialog name="What's your name?"
		:can-close="false"
		size="small"
		class="oc-guest"
		data-oc-guest-dialog>
		<p class="oc-guest__lead">
			People editing “{{ canvasName }}” will see this name next to your cursor and your changes.
		</p>
		<form @submit.prevent="submit">
			<NcTextField ref="field"
				:value.sync="name"
				label="Your name"
				:label-visible="true"
				:maxlength="64"
				autocomplete="name"
				data-oc-guest-name />
			<p class="oc-guest__note">
				<NcIconSvgWrapper :svg="infoIcon" :size="16" />
				<span>Saved in this browser so you won't be asked again.</span>
			</p>
		</form>
		<template #actions>
			<NcButton type="primary" :disabled="!clean" data-oc-guest-continue @click="submit">
				Continue
			</NcButton>
		</template>
	</NcDialog>
</template>

<script>
import NcButton from '@nextcloud/vue/dist/Components/NcButton.js'
import NcDialog from '@nextcloud/vue/dist/Components/NcDialog.js'
import NcIconSvgWrapper from '@nextcloud/vue/dist/Components/NcIconSvgWrapper.js'
import NcTextField from '@nextcloud/vue/dist/Components/NcTextField.js'
import { info } from '../icons.js'
import { cleanGuestName } from '../lib/guest.js'

export default {
	name: 'GuestNameDialog',
	components: { NcButton, NcDialog, NcIconSvgWrapper, NcTextField },
	props: {
		canvasName: { type: String, required: true },
		initial: { type: String, default: '' },
	},
	emits: ['submit'],
	data() {
		return { name: this.initial, infoIcon: info }
	},
	computed: {
		clean() {
			return cleanGuestName(this.name)
		},
	},
	mounted() {
		this.$nextTick(() => this.$refs.field?.focus?.())
	},
	methods: {
		submit() {
			if (this.clean) {
				this.$emit('submit', this.clean)
			}
		},
	},
}
</script>

<style scoped>
.oc-guest__lead {
	color: var(--color-text-maxcontrast);
	margin-bottom: 16px;
}
.oc-guest__note {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-top: 8px;
	color: var(--color-text-maxcontrast);
	font-size: 13px;
}
</style>
