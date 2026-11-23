// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice
//
// S1c-S1e: default names, clashes and Nextcloud's name rules in the "New … canvas" dialog.
import { describe, expect, it } from 'vitest'
import { defaultName, validateName, withExtension } from '../../src/lib/names.js'

const rules = { forbiddenCharacters: ['/', '\\'], forbiddenNames: ['.htaccess'], forbiddenBasenames: ['con'] }

describe('defaultName', () => {
	it('uses the plain name when it is free', () => {
		expect(defaultName('New database', ['Q1 launch plan.ocanvas'])).toBe('New database.ocanvas')
	})
	it('numbers the name when it is taken (S1c: "New canvas (2)")', () => {
		expect(defaultName('New canvas', ['New canvas.ocanvas'])).toBe('New canvas (2).ocanvas')
		expect(defaultName('New canvas', ['New canvas.ocanvas', 'New canvas (2).ocanvas'])).toBe('New canvas (3).ocanvas')
	})
})

describe('withExtension', () => {
	it('adds .ocanvas once', () => {
		expect(withExtension('Plan')).toBe('Plan.ocanvas')
		expect(withExtension('Plan.ocanvas')).toBe('Plan.ocanvas')
		expect(withExtension('  Plan  ')).toBe('Plan.ocanvas')
	})
})

describe('validateName', () => {
	it('accepts a normal free name', () => {
		expect(validateName('Hiring pipeline.ocanvas', ['Q1 launch plan.ocanvas'], rules)).toBe(null)
	})
	it('S1d: refuses a name already in the folder, in plain words', () => {
		expect(validateName('Q1 launch plan.ocanvas', ['Q1 launch plan.ocanvas'], rules))
			.toBe('There\'s already a file called "Q1 launch plan.ocanvas" in this folder.')
	})
	it('S1d: the extension is added before checking for a clash', () => {
		expect(validateName('Q1 launch plan', ['Q1 launch plan.ocanvas'], rules))
			.toBe('There\'s already a file called "Q1 launch plan.ocanvas" in this folder.')
	})
	it('S1e: a slash gets a suggestion', () => {
		expect(validateName('Q1/Q2 roadmap.ocanvas', [], rules)).toBe('Names can\'t contain "/". Try "Q1-Q2 roadmap".')
	})
	it('S1e: empty and dot names', () => {
		expect(validateName('', [], rules)).toBe('Enter a name')
		expect(validateName('   .ocanvas', [], rules)).toBe('Enter a name')
		expect(validateName('.hidden.ocanvas', [], rules)).toBe('Names can\'t start with a dot.')
	})
	it('S1e: reserved names from Nextcloud\'s rules', () => {
		expect(validateName('con.ocanvas', [], rules)).toBe('"con" is a reserved name.')
	})
})
