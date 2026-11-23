<!--
  - SPDX-License-Identifier: Apache-2.0
  - Copyright 2026 CasualOffice
  -
  - S1c-S1e, S1h: the name dialog of "New database canvas" and "New whiteboard canvas", in the look
  - of Nextcloud's own new-file dialog. The name is selected without the extension; a clash or a
  - name Nextcloud doesn't allow turns the field red and disables Create; Create shows "Creating…".
  -->
<template>
	<NcDialog :name="title"
		size="normal"
		class="oc-name"
		data-oc-name-dialog
		@closing="$emit('close')">
		<form @submit.prevent="submit">
			<NcTextField ref="field"
				:value.sync="name"
				label="Name"
				:error="!!message"
				:helper-text="message || 'It opens in OpenCanvas as soon as it\'s created.'"
				:disabled="busy"
				data-oc-name-field />
		</form>
		<template #actions>
			<NcButton type="primary"
				:disabled="!!message || busy"
				data-oc-name-create
				@click="submit">
				<template v-if="busy" #icon>
					<NcLoadingIcon :size="20" />
				</template>
				{{ busy ? 'Creating…' : 'Create' }}
			</NcButton>
		</template>
	</NcDialog>
</template>

<script>
import NcButton from '@nextcloud/vue/dist/Components/NcButton.js'
import NcDialog from '@nextcloud/vue/dist/Components/NcDialog.js'
import NcLoadingIcon from '@nextcloud/vue/dist/Components/NcLoadingIcon.js'
import NcTextField from '@nextcloud/vue/dist/Components/NcTextField.js'
import { EXT, validateName, withExtension } from '../lib/names.js'

export default {
	name: 'NameDialog',
	components: { NcButton, NcDialog, NcLoadingIcon, NcTextField },
	props: {
		title: { type: String, required: true },
		initial: { type: String, required: true },
		existing: { type: Array, default: () => [] },
		rules: { type: Object, default: () => ({}) },
		/** async (fullName) => void; throws to keep the dialog open */
		create: { type: Function, required: true },
	},
	emits: ['close'],
	data() {
		return { name: this.initial, busy: false }
	},
	computed: {
		message() {
			return validateName(this.name, this.existing, this.rules)
		},
	},
	mounted() {
		this.$nextTick(() => {
			const input = document.querySelector('input[data-oc-name-field], [data-oc-name-field] input')
			if (input) {
				input.focus()
				const end = this.name.toLowerCase().endsWith(EXT) ? this.name.length - EXT.length : this.name.length
				input.setSelectionRange(0, end)
			}
		})
	},
	methods: {
		async submit() {
			if (this.message || this.busy) {
				return
			}
			this.busy = true
			try {
				await this.create(withExtension(this.name))
				this.$emit('close')
			} catch {
				this.busy = false
			}
		},
	},
}
</script>
