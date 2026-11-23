// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// S2: the .ocanvas icon wherever Nextcloud's browser side shows a file-type icon.
import { describe, expect, it } from 'vitest'
import { installMimeIcon, isOurMimeIconUrl, rewriteIcons } from '../../src/lib/mimeicon.js'

window._oc_webroot = ''
window._oc_appswebroots = { opencanvas: '/custom_apps/opencanvas' }

describe('mime icon', () => {
	it('answers our type from OC.MimeType.getIconUrl and leaves others alone', () => {
		const win = { OC: { MimeType: { getIconUrl: (m) => `/core/img/filetypes/${m}.svg` } } }
		expect(installMimeIcon(win)).toBe(true)
		expect(win.OC.MimeType.getIconUrl('application/vnd.opencanvas+zip')).toMatch(/opencanvas\/img\/ocanvas\.svg$/)
		expect(win.OC.MimeType.getIconUrl('text/plain')).toBe('/core/img/filetypes/text/plain.svg')
		expect(installMimeIcon(win)).toBe(false) // once
	})
	it('recognises the server-side icon URL the Files list uses', () => {
		expect(isOurMimeIconUrl('http://nc/core/mimeicon?mime=application%2Fvnd.opencanvas%2Bzip')).toBe(true)
		expect(isOurMimeIconUrl('/index.php/core/mimeicon?mime=application/vnd.opencanvas+zip')).toBe(true)
		expect(isOurMimeIconUrl('/core/mimeicon?mime=text%2Fplain')).toBe(false)
		expect(isOurMimeIconUrl('')).toBe(false)
	})
	it('rewrites those images', () => {
		document.body.innerHTML = '<img id="a" src="/core/mimeicon?mime=application%2Fvnd.opencanvas%2Bzip"><img id="b" src="/core/mimeicon?mime=text%2Fplain">'
		rewriteIcons(document.body)
		expect(document.getElementById('a').getAttribute('src')).toMatch(/ocanvas\.svg$/)
		expect(document.getElementById('b').getAttribute('src')).toBe('/core/mimeicon?mime=text%2Fplain')
	})
})
