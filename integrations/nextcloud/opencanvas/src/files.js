// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// UNSTYLED PLACEHOLDER (ADR-011). Wiring only: labels, icons, order and every state wait for an
// approved prototype (UI-SCREENS.md). NOT BUILT OR RUN: needs a bundler (vite/webpack) to become
// js/opencanvas-files.js. Written against @nextcloud/files v3 (Nextcloud 30-32), where actions
// are `new FileAction({...})`; v4 takes plain objects.
import { FileAction, addNewFileMenuEntry, registerFileAction, Permission } from '@nextcloud/files'
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

const MIME = 'application/vnd.opencanvas+zip'
const PLACEHOLDER_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>'

// "Open in OpenCanvas" (default action on .ocanvas files when the Viewer is not used).
registerFileAction(new FileAction({
	id: 'opencanvas-open',
	displayName: () => 'Open in OpenCanvas',
	iconSvgInline: () => PLACEHOLDER_ICON,
	enabled: (nodes) => nodes.length === 1 && nodes[0].mime === MIME,
	exec: async (node) => {
		window.location.href = generateUrl('/apps/opencanvas/open/{fileId}', { fileId: node.fileid })
		return null
	},
	default: 'default',
}))

// "New database" and "New whiteboard" (the plain "New canvas" comes from the server-side
// TemplateFileCreator). Both create a starter .ocanvas through the app's API, then open it.
for (const [kind, label] of [['database', 'New database canvas'], ['whiteboard', 'New whiteboard canvas']]) {
	addNewFileMenuEntry({
		id: `opencanvas-new-${kind}`,
		displayName: label,
		iconSvgInline: PLACEHOLDER_ICON,
		enabled: (folder) => (folder.permissions & Permission.CREATE) !== 0,
		async handler(folder) {
			const name = window.prompt('Name', label.replace('New ', '')) // placeholder for the approved dialog
			if (!name) return
			const { data } = await axios.post(generateUrl('/apps/opencanvas/api/v1/create'), { dir: folder.path, name, kind })
			window.location.href = generateUrl('/apps/opencanvas/open/{fileId}', { fileId: data.fileId })
		},
	})
}
