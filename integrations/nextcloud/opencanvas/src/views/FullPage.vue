<!--
  - SPDX-License-Identifier: Apache-2.0
  - Copyright 2026 CasualOffice
  -
  - S5: the canvas on its own page at /apps/opencanvas/open/{id}. Nextcloud's header stays; a slim
  - bar has "Files" (back to the folder the canvas is in), the name and folder, then Share, details
  - and "…". On a phone only the back arrow, the name and "…" stay (S5e). The tab title follows
  - Nextcloud's "page - app - instance" pattern (S5a) and becomes "Canvas not found …" (S5d).
  -->
<template>
	<div class="oc-page" data-oc-fullpage>
		<header v-if="found" class="oc-bar" data-oc-bar>
			<NcButton type="tertiary" :href="filesUrl" class="oc-bar__back" data-oc-back aria-label="Back to Files">
				<template #icon>
					<NcIconSvgWrapper :svg="icons.arrowLeft" :size="20" />
				</template>
				<span class="oc-bar__back-label">Files</span>
			</NcButton>
			<span class="oc-bar__sep" />
			<NcIconSvgWrapper :svg="icons.ocanvas" :size="24" class="oc-bar__icon" />
			<div class="oc-bar__title">
				<span class="oc-bar__name" data-oc-name>{{ baseName }}<span class="oc-bar__ext">.ocanvas</span></span>
				<span class="oc-bar__dir">{{ folderLabel }}</span>
			</div>
			<div class="oc-bar__right">
				<NcButton class="oc-bar__wide" type="secondary" :href="detailsUrl" data-oc-share>
					<template #icon>
						<NcIconSvgWrapper :svg="icons.share2" :size="18" />
					</template>
					Share
				</NcButton>
				<NcButton class="oc-bar__wide" type="tertiary" :href="detailsUrl" aria-label="Details" title="Details">
					<template #icon>
						<NcIconSvgWrapper :svg="icons.panelRight" :size="20" />
					</template>
				</NcButton>
				<NcActions :force-menu="true" aria-label="More">
					<template #icon>
						<NcIconSvgWrapper :svg="icons.more" :size="20" />
					</template>
					<NcActionLink class="oc-bar__narrow" :href="detailsUrl">
						<template #icon>
							<NcIconSvgWrapper :svg="icons.share2" :size="20" />
						</template>
						Share
					</NcActionLink>
					<NcActionLink class="oc-bar__narrow" :href="detailsUrl">
						<template #icon>
							<NcIconSvgWrapper :svg="icons.panelRight" :size="20" />
						</template>
						Details
					</NcActionLink>
					<NcActionLink v-if="state.canDownload" :href="downloadUrl" download>
						<template #icon>
							<NcIconSvgWrapper :svg="icons.download" :size="20" />
						</template>
						Download
					</NcActionLink>
					<NcActionLink :href="filesUrl">
						<template #icon>
							<NcIconSvgWrapper :svg="icons.folder" :size="20" />
						</template>
						Show in Files
					</NcActionLink>
				</NcActions>
			</div>
		</header>
		<div class="oc-page__canvas">
			<CanvasFrame :fetch-launch="fetchLaunch"
				:display-name="baseName"
				surface="page"
				:is-admin="!!state.isAdmin"
				:can-download="!!state.canDownload"
				:download-url="downloadUrl"
				:preset-error="found ? null : { code: 'NOT_FOUND' }"
				@error="onError"
				@close="goToFiles"
				@open-file="openFile" />
		</div>
	</div>
</template>

<script>
import { generateRemoteUrl, generateUrl } from '@nextcloud/router'
import NcActionLink from '@nextcloud/vue/dist/Components/NcActionLink.js'
import NcActions from '@nextcloud/vue/dist/Components/NcActions.js'
import NcButton from '@nextcloud/vue/dist/Components/NcButton.js'
import NcIconSvgWrapper from '@nextcloud/vue/dist/Components/NcIconSvgWrapper.js'
import CanvasFrame from '../components/CanvasFrame.vue'
import * as icons from '../icons.js'
import { errorScreen } from '../lib/errors.js'
import { stripExtension, userLaunch } from '../lib/launch.js'
import { iconUrl } from '../lib/mimeicon.js'

export function pageTitle(name, instance) {
	return [name, 'OpenCanvas', instance].filter(Boolean).join(' - ')
}

export default {
	name: 'FullPage',
	components: { CanvasFrame, NcActionLink, NcActions, NcButton, NcIconSvgWrapper },
	props: {
		state: { type: Object, required: true },
	},
	data: () => ({ icons }),
	computed: {
		found() {
			return !!this.state.name
		},
		baseName() {
			return stripExtension(this.state.name)
		},
		folderLabel() {
			const parts = (this.state.dir ?? '/').split('/').filter(Boolean)
			return parts.length ? parts.join(' / ') : 'All files'
		},
		filesUrl() {
			return generateUrl('/apps/files/files/{fileId}?dir={dir}', { fileId: this.state.fileId, dir: this.state.dir ?? '/' })
		},
		detailsUrl() {
			// Nextcloud's Files sidebar (Sharing tab by default) for this file.
			return generateUrl('/apps/files/files/{fileId}?dir={dir}&opendetails=true', { fileId: this.state.fileId, dir: this.state.dir ?? '/' })
		},
		downloadUrl() {
			const path = (this.state.davPath ?? '').split('/').map(encodeURIComponent).join('/')
			return generateRemoteUrl(`dav/files/${encodeURIComponent(this.state.user ?? '')}`) + path
		},
	},
	created() {
		this.instance = (document.title.split(' - ').pop() || 'Nextcloud').trim()
		document.title = pageTitle(this.found ? this.baseName : errorScreen('NOT_FOUND', { surface: 'page' }).pageTitle, this.instance)
		if (this.found) {
			// The tab shows the canvas icon (S5a).
			document.querySelectorAll('link[rel~="icon"]').forEach((l) => l.setAttribute('href', iconUrl()))
		}
	},
	methods: {
		fetchLaunch() {
			return userLaunch(this.state.fileId)
		},
		onError(code) {
			if (code === 'NOT_FOUND') {
				document.title = pageTitle('Canvas not found', this.instance)
			}
		},
		goToFiles() {
			window.location.href = this.found ? this.filesUrl : generateUrl('/apps/files/')
		},
		openFile(fileId) {
			window.location.href = generateUrl('/apps/opencanvas/open/{fileId}', { fileId })
		},
	},
}
</script>

<style scoped>
.oc-page {
	display: flex;
	flex-direction: column;
	height: 100%;
	width: 100%;
	background: var(--color-main-background);
}
.oc-bar {
	display: flex;
	align-items: center;
	gap: 8px;
	min-height: 52px;
	padding: 4px 8px 4px 12px;
	border-bottom: 1px solid var(--color-border);
	box-sizing: border-box;
}
.oc-bar__sep {
	width: 1px;
	height: 24px;
	background: var(--color-border);
	margin: 0 6px 0 2px;
}
.oc-bar__icon {
	flex: none;
}
.oc-bar__title {
	display: flex;
	align-items: baseline;
	gap: 12px;
	min-width: 0;
	flex: 1 1 auto;
}
.oc-bar__name {
	font-weight: 600;
	font-size: 16px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.oc-bar__ext {
	font-weight: 400;
	color: var(--color-text-maxcontrast);
}
.oc-bar__dir {
	color: var(--color-text-maxcontrast);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.oc-bar__right {
	display: flex;
	align-items: center;
	gap: 4px;
	flex: none;
}
.oc-bar__narrow {
	display: none;
}
.oc-page__canvas {
	position: relative;
	flex: 1 1 auto;
	min-height: 0;
}
@media (max-width: 640px) {
	.oc-bar__back-label,
	.oc-bar__sep,
	.oc-bar__icon,
	.oc-bar__dir,
	.oc-bar__wide {
		display: none !important;
	}
	.oc-bar__narrow {
		display: list-item;
	}
}
</style>
