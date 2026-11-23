<!--
  - SPDX-License-Identifier: Apache-2.0
  - Copyright 2026 CasualOffice
  -
  - S8b: "Can comment in OpenCanvas" in a view-only share's advanced settings (admin switch, S12).
  -->
<template>
	<div v-if="!hidden" class="oc-comment" :class="{ 'oc-comment--on': checked }" data-oc-comment-option>
		<NcCheckboxRadioSwitch :checked="checked" @update:checked="$emit('update:checked', $event)">
			Can comment in OpenCanvas
		</NcCheckboxRadioSwitch>
		<p class="oc-comment__hint">
			{{ firstName || 'They' }} can add comments to the canvas but not change it.
		</p>
	</div>
</template>

<script>
import NcCheckboxRadioSwitch from '@nextcloud/vue/dist/Components/NcCheckboxRadioSwitch.js'

export default {
	name: 'CommentOption',
	components: { NcCheckboxRadioSwitch },
	props: {
		checked: { type: Boolean, default: false },
		hidden: { type: Boolean, default: false },
		name: { type: String, default: '' },
	},
	emits: ['update:checked'],
	computed: {
		firstName() {
			return this.name.split(/\s+/)[0] ?? ''
		},
	},
}
</script>

<style scoped>
.oc-comment {
	border-radius: var(--border-radius-large, 12px);
	padding: 2px 6px 8px;
	margin: 2px -6px;
}
.oc-comment--on {
	background: var(--color-primary-element-light);
}
.oc-comment__hint {
	margin: -6px 0 0 42px;
	font-size: 13px;
	color: var(--color-text-maxcontrast);
}
</style>
