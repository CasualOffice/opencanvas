// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// Names for new canvases (S1c-S1e): default name, clash and Nextcloud's own name rules, in plain
// words. The rules come from the `files` capability (forbidden characters, names, basenames).

export const EXT = '.ocanvas'

/** "Plan" -> "Plan.ocanvas"; keeps an existing .ocanvas (any case). */
export function withExtension(name) {
	const n = String(name ?? '').trim()
	return n.toLowerCase().endsWith(EXT) ? n : n + EXT
}

/** The default name, numbered like Nextcloud does when taken: "New canvas (2).ocanvas". */
export function defaultName(base, existing) {
	const taken = new Set(existing)
	if (!taken.has(base + EXT)) {
		return base + EXT
	}
	for (let i = 2; ; i++) {
		const candidate = `${base} (${i})${EXT}`
		if (!taken.has(candidate)) {
			return candidate
		}
	}
}

/**
 * @param {string} name what the person typed (with or without the extension)
 * @param {string[]} existing names already in the folder
 * @param {{forbiddenCharacters?: string[], forbiddenNames?: string[], forbiddenBasenames?: string[]}} rules
 * @return {string|null} the message to show, or null when the name is fine
 */
export function validateName(name, existing, rules = {}) {
	const full = withExtension(name)
	const base = full.slice(0, -EXT.length).trim()
	if (base === '') {
		return 'Enter a name'
	}
	const chars = rules.forbiddenCharacters ?? ['/', '\\']
	const bad = [...chars].find((c) => c !== '' && full.includes(c))
	if (bad !== undefined) {
		const suggestion = chars.reduce((s, c) => (c === '' ? s : s.split(c).join('-')), base)
		return `Names can't contain "${bad}". Try "${suggestion}".`
	}
	if (full.startsWith('.')) {
		return 'Names can\'t start with a dot.'
	}
	const lower = full.toLowerCase()
	if ((rules.forbiddenNames ?? []).some((n) => n.toLowerCase() === lower)
		|| (rules.forbiddenBasenames ?? []).some((n) => n.toLowerCase() === base.toLowerCase())) {
		return `"${base}" is a reserved name.`
	}
	if (existing.includes(full)) {
		return `There's already a file called "${full}" in this folder.`
	}
	return null
}

/** Nextcloud's name rules from the capabilities (Nextcloud 30+), with safe defaults. */
export function nameRules(capabilities) {
	const f = capabilities?.files ?? {}
	return {
		forbiddenCharacters: f.forbidden_filename_characters ?? ['/', '\\'],
		forbiddenNames: f.forbidden_filenames ?? ['.htaccess'],
		forbiddenBasenames: f.forbidden_filename_basenames ?? [],
	}
}
