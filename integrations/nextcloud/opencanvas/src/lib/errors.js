// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// S13: one set of messages for the Viewer (S4), the full page (S5) and public links (S7). Each says
// what happened, that the file is safe when it is, and the one thing to do next. Admins get a fix
// where users get "tell your administrator". Wording is the approved prototype's.
//
// `surface`: 'viewer' (has Close), 'page' (full page: no Close, Files instead), 'public' (guest:
// no Files, no admin links).

/** 132 MB, 1.5 GB: whole MB like the prototype, one decimal above 1 GB. */
export function formatSize(bytes) {
	const mb = bytes / (1024 * 1024)
	if (mb >= 1024) {
		return `${Math.round((mb / 1024) * 10) / 10} GB`
	}
	return `${Math.round(mb)} MB`
}

const close = { id: 'close', label: 'Close' }

/**
 * @param {string} code NOT_CONFIGURED | UNREACHABLE | PROOF_REJECTED | TOO_LARGE | NO_PERMISSION |
 *   NOT_FOUND | LINKS_DISABLED | PASSWORD_REQUIRED
 * @param {{isAdmin?: boolean, surface?: 'viewer'|'page'|'public', size?: number, owner?: string, canDownload?: boolean}} ctx
 * @return {{title: string, description: string, hint?: string, icon: string, pageTitle?: string,
 *   actions: {id: string, label: string, primary?: boolean, icon?: string}[]}}
 */
export function errorScreen(code, ctx = {}) {
	const surface = ctx.surface ?? 'viewer'
	const guest = surface === 'public'
	const admin = !!ctx.isAdmin && !guest
	const closable = surface === 'viewer' ? [close] : []
	switch (code) {
	case 'NOT_CONFIGURED':
		return admin
			? {
				icon: 'plug',
				title: 'Finish setting up OpenCanvas',
				description: 'Add your OpenCanvas server\'s address in the admin settings and run the connection check. Until then, nobody can open canvases.',
				actions: [{ id: 'admin', label: 'Open admin settings', primary: true, icon: 'settings' }, ...closable],
			}
			: {
				icon: 'plug',
				title: 'Canvases can\'t open yet',
				description: 'Your administrator still needs to connect Nextcloud to OpenCanvas. Your file is safe and nothing was changed.',
				actions: closable,
			}
	case 'PROOF_REJECTED':
		return admin
			? {
				icon: 'shieldAlert',
				title: 'This canvas couldn\'t open safely',
				description: 'OpenCanvas\'s calls didn\'t match its published security key.',
				hint: 'Usually OpenCanvas was restarted with a new proof key. Nextcloud fetches the new key within a minute; if it keeps failing, check that the key OpenCanvas uses is the one it publishes.',
				actions: [{ id: 'check', label: 'Run the connection check', primary: true, icon: 'settings' }],
			}
			: {
				icon: 'shieldAlert',
				title: 'This canvas couldn\'t open safely',
				description: 'Nextcloud couldn\'t confirm it was talking to your OpenCanvas server, so it stopped. Your file wasn\'t touched. Please tell your administrator.',
				actions: closable,
			}
	case 'TOO_LARGE':
		return {
			icon: 'fileWarning',
			title: 'This canvas is too large to open',
			description: `Canvases can be up to 100 MB, and this one is ${formatSize(ctx.size ?? 0)}, mostly images. You can still download it, or ask the owner to remove some images.`,
			actions: [...(ctx.canDownload === false ? [] : [{ id: 'download', label: 'Download', primary: true, icon: 'download' }]), ...closable],
		}
	case 'NO_PERMISSION':
		return {
			icon: 'lock',
			title: 'You don\'t have access to this canvas',
			description: 'It isn\'t shared with you, or the share was removed. Ask the owner to share it with you.',
			actions: guest ? [] : [{ id: 'files', label: 'Back to Files', primary: true, icon: 'folder' }],
		}
	case 'NOT_FOUND':
		if (surface === 'page') {
			return {
				icon: 'fileX',
				title: 'This canvas isn\'t available',
				pageTitle: 'Canvas not found',
				description: 'It may have been deleted or moved, or it isn\'t shared with you. Check Deleted files, or ask whoever sent you the link.',
				actions: [{ id: 'files', label: 'Go to Files', primary: true, icon: 'folder' }],
			}
		}
		return {
			icon: 'fileX',
			title: 'This canvas isn\'t available',
			description: guest
				? 'It may have been deleted or moved. Ask whoever sent you the link.'
				: 'It may have been deleted or moved. Check Deleted files, or ask whoever sent you the link.',
			actions: guest ? [] : [{ id: 'trash', label: 'Open Deleted files', primary: true, icon: 'trash' }, ...closable],
		}
	case 'LINKS_DISABLED':
		return {
			icon: 'link',
			title: 'This canvas can\'t be opened from a link',
			description: `Opening canvases from public links is turned off on this Nextcloud. Ask ${ctx.owner || 'the owner'} to share it with your account instead.`,
			actions: [],
		}
	case 'PASSWORD_REQUIRED':
		return {
			icon: 'lock',
			title: 'This link needs its password',
			description: 'Reload the page and enter the password you were given.',
			actions: [{ id: 'reload', label: 'Reload', primary: true, icon: 'refreshCw' }],
		}
	case 'UNREACHABLE':
	default:
		return {
			icon: 'cloudOff',
			title: 'Can\'t reach OpenCanvas',
			description: 'The canvas server isn\'t answering. Your file is safe in Nextcloud. Try again in a minute; if it keeps happening, tell your administrator.',
			actions: [{ id: 'retry', label: 'Try again', primary: true, icon: 'refreshCw' }, ...closable],
		}
	}
}

const KNOWN = ['NOT_CONFIGURED', 'UNREACHABLE', 'PROOF_REJECTED', 'TOO_LARGE', 'NO_PERMISSION', 'NOT_FOUND', 'LINKS_DISABLED', 'PASSWORD_REQUIRED']

/** The error code for a failed app API answer (token, public token, diagnose). */
export function codeFromResponse(status, body) {
	const code = body && typeof body === 'object' ? body.error : undefined
	if (code === 'NOT_AVAILABLE') {
		return 'LINKS_DISABLED'
	}
	if (KNOWN.includes(code)) {
		return code
	}
	if (status === 404) {
		return 'NOT_FOUND'
	}
	if (status === 403 || status === 401) {
		return 'NO_PERMISSION'
	}
	return 'UNREACHABLE'
}

/** The code (and size) for a failed launch request. Never axios's own `code` (ERR_BAD_REQUEST…). */
export function codeFromError(e) {
	const res = e?.response
	return { code: codeFromResponse(res?.status ?? 0, res?.data), size: Number(res?.data?.size ?? 0) }
}
