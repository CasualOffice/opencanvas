// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// S12: Administration > OpenCanvas (templates/admin.php, lib/Settings/Admin.php).
import Vue from 'vue'
import { loadState } from '@nextcloud/initial-state'
import AdminSettings from './views/AdminSettings.vue'

const el = document.getElementById('opencanvas-admin')
if (el) {
	// eslint-disable-next-line no-new
	new Vue({ el, render: (h) => h(AdminSettings, { props: { initial: loadState('opencanvas', 'admin', {}) } }) })
}
