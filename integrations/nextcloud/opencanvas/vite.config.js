// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// Nextcloud's standard app build (@nextcloud/vite-config, Vue 2.7 like Nextcloud 30-32).
// Output: js/opencanvas-<entry>.mjs, loaded with Util::addScript('opencanvas', 'opencanvas-<entry>').
// `npm run build` before installing; js/ is not committed (app-store apps build at release).
import { createAppConfig } from '@nextcloud/vite-config'

export default createAppConfig({
	files: 'src/files.js',
	viewer: 'src/viewer.js',
	fullpage: 'src/fullpage.js',
	public: 'src/public.js',
	admin: 'src/admin.js',
	talk: 'src/talk.js',
	reference: 'src/reference.js',
}, {
	inlineCSS: { relativeCSSInjection: true },
	thirdPartyLicense: false,
	config: {
		test: {
			environment: 'jsdom',
			include: ['tests/js/**/*.test.js'],
		},
	},
})
