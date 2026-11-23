<!--
  - SPDX-License-Identifier: Apache-2.0
  - Copyright 2026 CasualOffice
  -
  - S13 shared errors: Nextcloud's empty-content layout, a Lucide icon, the message and the one
  - thing to do next. Used in the Viewer (S4g-S4i), on the full page (S5d) and on public links (S7f).
  -->
<template>
	<div class="oc-error" :class="{ 'oc-error--compact': compact }" data-oc-error :data-code="code">
		<NcEmptyContent :name="screen.title" :description="screen.description">
			<template #icon>
				<NcIconSvgWrapper :svg="icon" :size="64" class="oc-error__icon" />
			</template>
			<template v-if="screen.actions.length || screen.hint" #action>
				<div class="oc-error__actions">
					<NcButton v-for="a in screen.actions"
						:key="a.id"
						:type="a.primary ? 'primary' : 'tertiary'"
						:data-oc-action="a.id"
						@click="$emit('action', a.id)">
						<template v-if="a.icon && a.primary" #icon>
							<NcIconSvgWrapper :svg="iconFor(a.icon)" :size="18" />
						</template>
						{{ a.label }}
					</NcButton>
				</div>
				<p v-if="screen.hint" class="oc-error__hint">
					<NcIconSvgWrapper :svg="infoIcon" :size="16" />
					<span>{{ screen.hint }}</span>
				</p>
			</template>
		</NcEmptyContent>
	</div>
</template>

<script>
import NcButton from '@nextcloud/vue/dist/Components/NcButton.js'
import NcEmptyContent from '@nextcloud/vue/dist/Components/NcEmptyContent.js'
import NcIconSvgWrapper from '@nextcloud/vue/dist/Components/NcIconSvgWrapper.js'
import * as icons from '../icons.js'

export default {
	name: 'ErrorScreen',
	components: { NcButton, NcEmptyContent, NcIconSvgWrapper },
	props: {
		code: { type: String, required: true },
		screen: { type: Object, required: true },
		compact: { type: Boolean, default: false },
	},
	emits: ['action'],
	computed: {
		icon() {
			return icons[this.screen.icon] ?? icons.cloudOff
		},
		infoIcon() {
			return icons.info
		},
	},
	methods: {
		iconFor(name) {
			return icons[name] ?? ''
		},
	},
}
</script>

<style scoped>
.oc-error {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	background: var(--color-main-background);
	color: var(--color-main-text);
	padding: 16px;
	box-sizing: border-box;
	overflow: auto;
}
.oc-error :deep(.empty-content) {
	margin-top: 0;
	max-width: 420px;
	text-align: center;
}
.oc-error :deep(.empty-content__description) {
	color: var(--color-text-maxcontrast);
}
.oc-error__icon {
	color: var(--color-text-maxcontrast);
	opacity: .75;
}
.oc-error__actions {
	display: flex;
	gap: 8px;
	justify-content: center;
	flex-wrap: wrap;
}
.oc-error__hint {
	display: flex;
	gap: 8px;
	align-items: flex-start;
	margin-top: 16px;
	padding: 12px;
	border-radius: var(--border-radius-large);
	background: var(--color-background-hover);
	color: var(--color-text-maxcontrast);
	text-align: start;
	font-size: 13px;
}
</style>
