// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// Files app (Nextcloud 30-32, @nextcloud/files v3):
//  - S6b: clicking a canvas opens it in the Viewer (the Viewer's own default action); the "…" menu
//    gets "Open in full page". Without the Viewer app, "Open in OpenCanvas" (full page) is the default.
//  - S1a: "New canvas", "New database canvas", "New whiteboard canvas" together, after a separator.
//  - S2: the .ocanvas file icon.
//  - S8a/S8b: the sharing card and the optional "Can comment in OpenCanvas" share option.
import Vue from 'vue'
import axios from '@nextcloud/axios'
import { getCapabilities } from '@nextcloud/capabilities'
import { showError } from '@nextcloud/dialogs'
import { emit } from '@nextcloud/event-bus'
import {
	DefaultType, FileAction, NewMenuEntryCategory, Permission,
	addNewFileMenuEntry, davGetClient, davGetDefaultPropfind, davResultToNode, davRootPath,
	getNewFileMenuEntries, registerFileAction, removeNewFileMenuEntry,
} from '@nextcloud/files'
import { loadState } from '@nextcloud/initial-state'
import { generateUrl } from '@nextcloud/router'
import NameDialog from './components/NameDialog.vue'
import { maximize, ocanvas, ocanvasDatabase, ocanvasWhiteboard } from './icons.js'
import { MIME, installMimeIcon, watchMimeIcons } from './lib/mimeicon.js'
import { defaultName, nameRules } from './lib/names.js'
import { registerSharing } from './sharing.js'

installMimeIcon()
watchMimeIcons()

const isCanvas = (nodes) => nodes.length === 1 && nodes[0].mime === MIME && (nodes[0].permissions & Permission.READ) !== 0
const fullPage = (node) => { window.location.href = generateUrl('/apps/opencanvas/open/{fileId}', { fileId: node.fileid }) }
const viewerHandles = () => !!window.OCA?.Viewer?.mimetypes?.includes(MIME)

// S6b: the second way to open, in the row's "…" menu.
registerFileAction(new FileAction({
	id: 'opencanvas-open-full-page',
	displayName: () => 'Open in full page',
	iconSvgInline: () => maximize,
	order: -50,
	enabled: (nodes) => isCanvas(nodes) && viewerHandles(),
	exec: async (node) => {
		fullPage(node)
		return null
	},
}))

// Without the Viewer app, clicking the name opens the full page (S6a).
registerFileAction(new FileAction({
	id: 'opencanvas-open',
	displayName: () => 'Open in OpenCanvas',
	iconSvgInline: () => maximize,
	order: -50,
	default: DefaultType.DEFAULT,
	enabled: (nodes) => isCanvas(nodes) && !viewerHandles(),
	exec: async (node) => {
		fullPage(node)
		return null
	},
}))

/** Opens the new file the way Files opens one made from a template (Viewer, S4). */
async function openCreated(folder, fileId, name) {
	const path = `${folder.path.replace(/\/$/, '')}/${name}`
	const { data } = await davGetClient().stat(`${davRootPath}${path}`, { details: true, data: davGetDefaultPropfind() })
	emit('files:node:created', davResultToNode(data))
	window.OCP?.Files?.Router?.goToRoute(
		null,
		{ view: 'files', fileid: String(fileId) },
		{ dir: folder.path, openfile: 'true' },
	)
}

function askName({ title, base, folder, content, kind }) {
	const el = document.createElement('div')
	document.body.appendChild(el)
	const existing = content.map((n) => n.basename)
	const vm = new Vue({
		el,
		render: (h) => h(NameDialog, {
			props: {
				title,
				initial: defaultName(base, existing),
				existing,
				rules: nameRules(getCapabilities()),
				async create(name) {
					let data
					try {
						({ data } = await axios.post(generateUrl('/apps/opencanvas/api/v1/create'), { dir: folder.path, name, kind }))
					} catch (e) {
						const res = e?.response
						// S1f: permission removed after the menu opened. The dialog closes, the toast explains.
						showError(res?.status === 403
							? `The canvas wasn't created. You can no longer add files to "${folder.basename}".`
								+ (res.data?.owner ? ` Ask ${res.data.owner} for permission.` : '')
							: 'The canvas wasn\'t created. Try again in a moment.')
						return
					}
					await openCreated(folder, data.fileId, data.name).catch(() => {
						window.location.href = generateUrl('/apps/opencanvas/open/{fileId}', { fileId: data.fileId })
					})
				},
			},
			on: { close: () => { vm.$destroy(); el.remove() } },
		}),
	})
}

// S1a: our entries after a separator ("Other" category), in this order.
const canCreate = (folder) => (folder.permissions & Permission.CREATE) !== 0
for (const [order, kind, label, base, icon] of [
	[2, 'database', 'New database canvas', 'New database', ocanvasDatabase],
	[3, 'whiteboard', 'New whiteboard canvas', 'New whiteboard', ocanvasWhiteboard],
]) {
	addNewFileMenuEntry({
		id: `opencanvas-new-${kind}`,
		displayName: label,
		iconSvgInline: icon,
		category: NewMenuEntryCategory.Other,
		order,
		enabled: canCreate,
		handler(folder, content) {
			askName({ title: label, base, folder, content, kind })
		},
	})
}

/**
 * "New canvas" is the server's template creator (it also feeds Talk's "New file" menu and the
 * template picker, S3/S11). Files lists those among its own "Create new" entries; move ours next
 * to the two above, keeping Nextcloud's own handler (its name dialog and template picker).
 */
function relocateTemplateEntry() {
	const entry = getNewFileMenuEntries().find((e) => /^template-new-opencanvas-/.test(e.id))
	if (!entry) {
		return false
	}
	removeNewFileMenuEntry(entry)
	addNewFileMenuEntry({
		id: 'opencanvas-new-canvas',
		displayName: 'New canvas',
		iconSvgInline: ocanvas,
		category: NewMenuEntryCategory.Other,
		order: 1,
		enabled: entry.enabled ?? canCreate,
		handler: entry.handler,
	})
	return true
}
let tries = 0
const retry = () => {
	if (!relocateTemplateEntry() && ++tries < 40) {
		setTimeout(retry, 250)
	}
}
retry()

registerSharing({ commentRole: loadState('opencanvas', 'files', {}).commentRole === true })

/**
 * S5 "Share" and details on the full page link to /apps/files/files/{id}?dir=…&opendetails=true.
 * Nextcloud 32 opens the sidebar for that itself; Nextcloud 30-31 only scroll to the file, so open
 * it here (Sharing tab), once the file's row is on screen.
 */
function openDetailsFromUrl() {
	const q = new URLSearchParams(window.location.search)
	const id = window.location.pathname.match(/\/apps\/files\/files\/(\d+)/)?.[1]
	if (!id || !q.has('opendetails') || q.get('opendetails') === 'false') {
		return
	}
	let n = 0
	const tick = () => {
		const rowEl = document.querySelector(`[data-cy-files-list-row-fileid="${id}"]`)
		const sidebar = window.OCA?.Files?.Sidebar
		if (rowEl && sidebar?.open) {
			if (!document.querySelector('.app-sidebar')) {
				const dir = (q.get('dir') ?? '/').replace(/\/$/, '')
				sidebar.open(`${dir}/${rowEl.getAttribute('data-cy-files-list-row-name')}`)
				sidebar.setActiveTab?.('sharing')
			}
			return
		}
		if (++n < 60) {
			setTimeout(tick, 250)
		}
	}
	tick()
}
openDetailsFromUrl()
