<!--
  - SPDX-License-Identifier: Apache-2.0
  - Copyright 2026 CasualOffice
  -
  - S12: Administration > OpenCanvas. Order follows the setup steps: address, save, copy the
  - allow-list line into OpenCanvas, run the check, then the sharing switches. The token secret is
  - never shown; admins only get "End all open sessions".
  -->
<template>
	<div id="opencanvas-admin-page" class="oc-admin" data-oc-admin>
		<h2 class="oc-admin__title">
			<NcIconSvgWrapper :svg="icons.layoutTemplate" :size="24" />
			OpenCanvas
		</h2>
		<p class="oc-admin__lead">
			Create canvases (documents with databases and whiteboards) and edit them together, right from Files and Talk.
			Nextcloud keeps the files and decides who can open them; OpenCanvas only does the editing.
		</p>
		<NcNoteCard v-if="!configured" type="warning" class="oc-admin__note" data-oc-not-connected>
			<strong>Not connected yet.</strong> Enter your OpenCanvas server's address and save. Until then, nobody can open canvases.
		</NcNoteCard>

		<h3>Server</h3>
		<form class="oc-admin__form" @submit.prevent="save">
			<NcTextField :value.sync="form.url"
				label="OpenCanvas address"
				placeholder="https://canvas.example.com"
				:error="!!urlCheck.error && touched.url"
				:helper-text="(touched.url && urlCheck.error) || urlCheck.hint || 'The address people\'s browsers use to reach OpenCanvas.'"
				data-oc-url
				@blur="touched.url = true" />
			<NcTextField :value.sync="form.internal"
				label="Internal address (optional)"
				placeholder="Same as above"
				:error="!!internalCheck.error"
				:helper-text="internalCheck.error || internalCheck.hint || 'Only if Nextcloud reaches OpenCanvas on a different address, for example inside Docker.'"
				data-oc-internal />
			<NcPasswordField :value.sync="form.apiKey"
				label="API key"
				:placeholder="settings.api_key_set ? '••••••••••••••••••••••••' : 'From api_key in opencanvas.hosts.toml'"
				helper-text="Lets an open canvas switch to view only or close the moment a share changes. Without it, changes apply the next time the canvas saves or opens."
				autocomplete="new-password"
				data-oc-apikey />
			<div>
				<NcButton type="primary" native-type="submit" :disabled="!canSave" data-oc-save>
					<template v-if="saving" #icon>
						<NcLoadingIcon :size="20" />
					</template>
					{{ saving ? 'Saving…' : 'Save' }}
				</NcButton>
			</div>
		</form>

		<template v-if="configured">
			<h3>Allow this Nextcloud in OpenCanvas</h3>
			<p class="oc-admin__text">
				Copy this address into <code>wopi_allowlist</code> in OpenCanvas's hosts file. OpenCanvas only opens files from addresses on that list.
			</p>
			<div class="oc-admin__copy">
				<code class="oc-admin__code" data-oc-wopi-base>{{ settings.wopi_base }}</code>
				<NcButton type="secondary" data-oc-copy @click="copy(settings.wopi_base)">
					<template #icon>
						<NcIconSvgWrapper :svg="icons.copy" :size="18" />
					</template>
					Copy
				</NcButton>
			</div>
			<p v-if="!showWopi" class="oc-admin__text">
				<a href="#" class="oc-admin__link" @click.prevent="showWopi = true">Use a different address</a>
				(behind a proxy, or reached internally)
			</p>
			<form v-else class="oc-admin__form" @submit.prevent="saveWopi">
				<NcTextField :value.sync="form.wopi"
					label="Address OpenCanvas uses to reach Nextcloud"
					:placeholder="settings.wopi_base"
					helper-text="Leave empty for the default. It must end in /index.php/apps/opencanvas/wopi." />
				<div>
					<NcButton type="secondary" native-type="submit">
						Save address
					</NcButton>
				</div>
			</form>
		</template>

		<h3>Connection check</h3>
		<div class="oc-check" :data-status="headline.status" data-oc-check>
			<div class="oc-check__head">
				<NcLoadingIcon v-if="checking" :size="20" />
				<NcIconSvgWrapper v-else :svg="statusIcon(headline.status)" :size="20" :class="`oc-st--${headline.status}`" />
				<strong class="oc-check__title" data-oc-check-title>{{ checking && !steps ? 'Checking…' : headline.title }}</strong>
				<span v-if="checkedAt && !checking" class="oc-check__when">{{ checkedText }}</span>
				<NcButton type="tertiary" :disabled="!configured || checking" data-oc-check-run @click="runCheck">
					<template #icon>
						<NcIconSvgWrapper :svg="icons.refreshCw" :size="18" />
					</template>
					{{ steps ? 'Check again' : 'Check' }}
				</NcButton>
			</div>
			<ul v-if="steps" class="oc-check__steps">
				<li v-for="s in steps" :key="s.id" class="oc-check__step" :data-step="s.id" :data-status="s.status">
					<NcIconSvgWrapper :svg="statusIcon(s.status)" :size="20" :class="`oc-st--${s.status}`" />
					<div class="oc-check__body">
						<div class="oc-check__label">
							{{ stepLabel(s.id) }}
						</div>
						<div v-if="s.detail" class="oc-check__detail">
							{{ s.detail }}
						</div>
						<div v-if="s.fix" class="oc-check__fix">
							<code>{{ s.fix }}</code>
							<NcButton v-if="s.id === 'accepts'" type="tertiary" @click="copy(s.fix)">
								<template #icon>
									<NcIconSvgWrapper :svg="icons.copy" :size="18" />
								</template>
								Copy
							</NcButton>
						</div>
					</div>
				</li>
			</ul>
		</div>

		<h3>Sharing</h3>
		<div class="oc-admin__switch">
			<NcCheckboxRadioSwitch type="switch"
				:checked="settings.allow_public_links"
				data-oc-public-links
				@update:checked="toggle('allow_public_links', $event)">
				Let guests open canvases from public links
			</NcCheckboxRadioSwitch>
			<p class="oc-admin__sub">
				Applies to every public link. Link options such as "Hide download" still apply.
			</p>
		</div>
		<div class="oc-admin__switch">
			<NcCheckboxRadioSwitch type="switch"
				:checked="settings.allow_comment_role"
				data-oc-comment-role
				@update:checked="toggle('allow_comment_role', $event)">
				Offer "Can comment" on view-only shares
			</NcCheckboxRadioSwitch>
			<p class="oc-admin__sub">
				Adds a "Can comment in OpenCanvas" option to share settings. Comments from people who can only comment are saved while someone who can edit has the canvas open.
			</p>
		</div>

		<h3>Sessions</h3>
		<p class="oc-admin__text">
			Canvas sessions last up to 10 hours. If you think a session link was leaked, end every open session at once.
		</p>
		<NcButton type="error" data-oc-end-sessions @click="confirmEnd = true">
			<template #icon>
				<NcIconSvgWrapper :svg="icons.rotateCcw" :size="18" />
			</template>
			End all open sessions…
		</NcButton>
		<NcDialog v-if="confirmEnd"
			name="End all open canvas sessions?"
			size="small"
			data-oc-end-dialog
			@closing="confirmEnd = false">
			<p>
				Everyone who has a canvas open will be asked to reload it. Their work up to that moment is saved,
				and they can reopen the canvas right away. Use this if you think a session link was leaked. It can't be undone.
			</p>
			<template #actions>
				<NcButton type="tertiary" @click="confirmEnd = false">
					Cancel
				</NcButton>
				<NcButton type="error" data-oc-end-confirm @click="endSessions">
					End all sessions
				</NcButton>
			</template>
		</NcDialog>
	</div>
</template>

<script>
import axios from '@nextcloud/axios'
import { showError, showSuccess } from '@nextcloud/dialogs'
import { generateUrl } from '@nextcloud/router'
import NcButton from '@nextcloud/vue/dist/Components/NcButton.js'
import NcCheckboxRadioSwitch from '@nextcloud/vue/dist/Components/NcCheckboxRadioSwitch.js'
import NcDialog from '@nextcloud/vue/dist/Components/NcDialog.js'
import NcIconSvgWrapper from '@nextcloud/vue/dist/Components/NcIconSvgWrapper.js'
import NcLoadingIcon from '@nextcloud/vue/dist/Components/NcLoadingIcon.js'
import NcNoteCard from '@nextcloud/vue/dist/Components/NcNoteCard.js'
import NcPasswordField from '@nextcloud/vue/dist/Components/NcPasswordField.js'
import NcTextField from '@nextcloud/vue/dist/Components/NcTextField.js'
import * as icons from '../icons.js'
import { checkHeadline, checkedLabel, validateAddress } from '../lib/settings.js'

const LABELS = {
	answers: 'OpenCanvas answers',
	action: 'Opens .ocanvas files',
	proofKey: 'Security key published',
	accepts: 'Accepts this Nextcloud',
}

export default {
	name: 'AdminSettings',
	components: { NcButton, NcCheckboxRadioSwitch, NcDialog, NcIconSvgWrapper, NcLoadingIcon, NcNoteCard, NcPasswordField, NcTextField },
	props: {
		initial: { type: Object, required: true },
	},
	data() {
		return {
			icons,
			settings: { ...this.initial },
			form: { url: this.initial.opencanvas_url ?? '', internal: this.initial.opencanvas_internal_url ?? '', apiKey: '', wopi: '' },
			touched: { url: false },
			saving: false,
			checking: false,
			steps: null,
			checkedAt: 0,
			now: Date.now(),
			showWopi: !!this.initial.wopi_base_custom,
			confirmEnd: false,
		}
	},
	computed: {
		configured() {
			return !!this.settings.opencanvas_url
		},
		urlCheck() {
			return validateAddress(this.form.url, { internal: false })
		},
		internalCheck() {
			return validateAddress(this.form.internal, { internal: true })
		},
		canSave() {
			return !this.saving && this.form.url.trim() !== '' && !this.urlCheck.error && !this.internalCheck.error
		},
		headline() {
			return checkHeadline(this.configured ? this.steps : null)
		},
		checkedText() {
			return checkedLabel(this.checkedAt, this.now)
		},
	},
	mounted() {
		this.tick = setInterval(() => { this.now = Date.now() }, 30000)
		if (this.configured) {
			this.runCheck()
		}
	},
	beforeDestroy() {
		clearInterval(this.tick)
	},
	methods: {
		stepLabel(id) {
			return LABELS[id] ?? id
		},
		statusIcon(status) {
			return status === 'ok' ? icons.circleCheck : status === 'fail' ? icons.circleX : icons.circleDashed
		},
		async post(settings) {
			const { data } = await axios.post(generateUrl('/apps/opencanvas/settings/admin'), { settings })
			this.settings = { ...this.settings, ...data }
			return data
		},
		async save() {
			this.touched.url = true
			if (!this.canSave) {
				return
			}
			this.saving = true
			try {
				const s = { opencanvas_url: this.form.url.trim(), opencanvas_internal_url: this.form.internal.trim() }
				if (this.form.apiKey.trim() !== '') {
					s.opencanvas_api_key = this.form.apiKey.trim()
				}
				await this.post(s)
				this.form.apiKey = ''
				showSuccess('Settings saved. Checking the connection…')
				this.runCheck()
			} catch (e) {
				showError('The settings weren\'t saved: ' + (e?.response?.data?.message ?? 'try again'))
			} finally {
				this.saving = false
			}
		},
		async saveWopi() {
			try {
				await this.post({ wopi_base: this.form.wopi.trim() })
				showSuccess('Address saved. Checking the connection…')
				this.runCheck()
			} catch (e) {
				showError('The address wasn\'t saved: ' + (e?.response?.data?.message ?? 'try again'))
			}
		},
		async toggle(key, value) {
			const before = this.settings[key]
			this.settings[key] = value
			try {
				await this.post({ [key]: value })
				showSuccess('Settings saved')
			} catch {
				this.settings[key] = before
				showError('The setting wasn\'t saved')
			}
		},
		async runCheck() {
			this.checking = true
			try {
				const { data } = await axios.post(generateUrl('/apps/opencanvas/settings/check'))
				this.steps = data.steps
			} catch {
				this.steps = [{ id: 'answers', status: 'fail', detail: 'Nextcloud couldn\'t run the check. Try again.' }]
			} finally {
				this.checking = false
				this.checkedAt = Date.now()
				this.now = Date.now()
			}
		},
		async copy(text) {
			try {
				await navigator.clipboard.writeText(text)
				showSuccess('Copied')
			} catch {
				showError('Couldn\'t copy. Select the text and copy it by hand.')
			}
		},
		async endSessions() {
			try {
				await axios.post(generateUrl('/apps/opencanvas/settings/rotate-secret'))
				showSuccess('All open canvas sessions were ended')
			} catch {
				showError('Sessions weren\'t ended. Try again.')
			} finally {
				this.confirmEnd = false
			}
		},
	},
}
</script>

<style scoped>
.oc-admin {
	padding: 30px;
	max-width: 760px;
}
.oc-admin__title {
	display: flex;
	align-items: center;
	gap: 10px;
	font-size: 20px;
	font-weight: 700;
	margin: 0 0 8px;
}
.oc-admin h3 {
	font-size: 16px;
	font-weight: 700;
	margin: 28px 0 12px;
}
.oc-admin__lead,
.oc-admin__text,
.oc-admin__sub {
	color: var(--color-text-maxcontrast);
	max-width: 720px;
}
.oc-admin__note {
	max-width: 720px;
}
.oc-admin__form {
	display: flex;
	flex-direction: column;
	gap: 14px;
	max-width: 560px;
}
.oc-admin__copy {
	display: flex;
	gap: 8px;
	align-items: stretch;
	max-width: 720px;
	margin: 8px 0;
}
.oc-admin__code {
	flex: 1 1 auto;
	display: flex;
	align-items: center;
	padding: 8px 12px;
	border-radius: var(--border-radius-large, 10px);
	background: var(--color-background-hover);
	font-family: var(--font-face-monospace, monospace);
	font-size: 13px;
	overflow-x: auto;
	white-space: nowrap;
}
.oc-admin__link {
	color: var(--color-primary-element);
}
.oc-admin__switch {
	margin-bottom: 12px;
}
.oc-admin__sub {
	margin: -4px 0 0 46px;
	font-size: 13px;
}
.oc-check {
	max-width: 720px;
	border: 1px solid var(--color-border);
	border-radius: var(--border-radius-large, 12px);
	overflow: hidden;
}
.oc-check__head {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 10px 12px 10px 16px;
	background: var(--color-background-hover);
}
.oc-check__title {
	flex: 1 1 auto;
}
.oc-check__when {
	color: var(--color-text-maxcontrast);
	font-size: 13px;
}
.oc-check__steps {
	list-style: none;
	margin: 0;
	padding: 0;
}
.oc-check__step {
	display: flex;
	gap: 10px;
	padding: 12px 16px;
	border-top: 1px solid var(--color-border);
}
.oc-check__step[data-status="skipped"] .oc-check__label {
	color: var(--color-text-maxcontrast);
}
.oc-check__detail {
	color: var(--color-text-maxcontrast);
	font-size: 13px;
}
.oc-check__fix {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-top: 6px;
}
.oc-check__fix code {
	font-family: var(--font-face-monospace, monospace);
	font-size: 12.5px;
	padding: 4px 8px;
	border-radius: 6px;
	background: var(--color-background-dark);
	overflow-wrap: anywhere;
}
.oc-st--ok {
	color: var(--color-success-text, var(--color-success));
}
.oc-st--fail {
	color: var(--color-error-text, var(--color-error));
}
.oc-st--skipped,
.oc-st--idle {
	color: var(--color-text-maxcontrast);
}
</style>
