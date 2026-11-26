<!--
  - SPDX-License-Identifier: Apache-2.0
  - Copyright 2026 CasualOffice
  -
  - TALK-01 2a: the Canvas button. Talk has no extension point in its top bar, so the button
  - moves itself into Talk's top-bar buttons when they are on the page and floats at the top
  - right otherwise. A dot shows while the panel is open.
  -->
<template>
	<button class="oct-btn"
		:class="{ 'oct-btn--float': !target }"
		type="button"
		:aria-pressed="open ? 'true' : 'false'"
		aria-label="Canvas"
		title="Canvas"
		data-oct-button
		@click="$emit('toggle')">
		<NcIconSvgWrapper :svg="icon" :size="20" />
		<span class="oct-btn__label">Canvas</span>
		<span v-if="open" class="oct-btn__dot" aria-hidden="true" />
	</button>
</template>

<script>
import NcIconSvgWrapper from '@nextcloud/vue/dist/Components/NcIconSvgWrapper.js'
import { layoutDashboard } from './icons.js'

export default {
	name: 'PortalButton',
	components: { NcIconSvgWrapper },
	props: {
		target: { type: Object, default: null },
		open: { type: Boolean, default: false },
		/** Bumped on every poll: Talk re-renders its top bar, so the button checks its place. */
		tick: { type: Number, default: 0 },
	},
	emits: ['toggle'],
	data: () => ({ icon: layoutDashboard, home: null }),
	watch: {
		target: 'place',
		tick: 'place',
	},
	mounted() {
		this.home = this.$el.parentNode
		this.place()
	},
	beforeDestroy() {
		this.$el.remove()
	},
	methods: {
		place() {
			const to = this.target && this.target.isConnected ? this.target : this.home
			if (to && this.$el.parentNode !== to) {
				to.prepend(this.$el)
			}
		},
	},
}
</script>

<style scoped>
.oct-btn {
	position: relative;
	display: inline-flex;
	align-items: center;
	gap: 0.375rem;
	min-height: 2.75rem;
	padding: 0 0.75rem;
	border: 0;
	border-radius: var(--border-radius-element, 2rem);
	background: var(--color-main-background);
	color: var(--color-main-text);
	cursor: pointer;
}
.oct-btn:hover,
.oct-btn:focus-visible {
	background: var(--color-background-hover);
}
.oct-btn--float {
	position: fixed;
	inset-block-start: calc(var(--header-height, 3.125rem) + 0.5rem);
	inset-inline-end: 1rem;
	z-index: 1990;
	box-shadow: 0 0.125rem 0.5rem rgba(0, 0, 0, 0.2);
}
.oct-btn__dot {
	position: absolute;
	inset-block-start: 0.375rem;
	inset-inline-end: 0.375rem;
	width: 0.5rem;
	height: 0.5rem;
	border-radius: 50%;
	background: var(--color-primary-element);
}
@media (max-width: 45em) {
	.oct-btn__label {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
}
</style>
