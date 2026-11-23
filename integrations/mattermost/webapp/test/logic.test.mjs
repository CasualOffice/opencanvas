// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Unit tests for src/logic.ts (MM-02): card wording, theme detection, launch and frame states.
//
//   npm test
import {buildSync} from 'esbuild';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';

const out = buildSync({entryPoints: [new URL('../src/logic.ts', import.meta.url).pathname], bundle: true, format: 'esm', write: false});
const file = join(mkdtempSync(join(tmpdir(), 'oc-mm-')), 'logic.mjs');
writeFileSync(file, out.outputFiles[0].text);
const L = await import(file);

const NOW = new Date(2026, 10, 24, 10, 0, 0).getTime(); // Tue 24 Nov 2026, 10:00 local
const ago = (ms) => NOW - ms;
const MIN = 60_000;
const DAY = 86_400_000;

test('relative time reads like the prototype (S1a, S4a)', () => {
    assert.equal(L.relTime(ago(10_000), NOW), 'just now');
    assert.equal(L.relTime(ago(4 * MIN), NOW), '4 min ago');
    assert.equal(L.relTime(ago(60 * MIN), NOW), '1 hour ago');
    assert.equal(L.relTime(ago(3 * 60 * MIN), NOW), '3 hours ago');
    assert.equal(L.relTime(new Date(2026, 10, 23, 18, 0).getTime(), NOW), 'yesterday');
    assert.equal(L.relTime(new Date(2026, 10, 16, 9, 0).getTime(), NOW), 'Nov 16');
    assert.equal(L.relTime(new Date(2026, 10, 19, 9, 0).getTime(), NOW), 'last Thursday');
    assert.equal(L.relTime(new Date(2025, 9, 28).getTime(), NOW), 'Oct 28, 2025');
});

test('card meta line', () => {
    assert.equal(L.cardMeta({template: '', version: 3, createdAt: ago(DAY * 30), updatedAt: ago(4 * MIN)}, NOW), 'Canvas · Edited 4 min ago');
    assert.equal(L.cardMeta({template: 'meeting', version: 1, createdAt: 0, updatedAt: ago(MIN)}, NOW), 'Meeting notes · Edited 1 min ago');
    assert.equal(L.cardMeta({template: '', version: 0, createdAt: ago(5_000), updatedAt: ago(5_000)}, NOW), 'Canvas · Created just now');
});

test('theme: Denim is light, Onyx is dark', () => {
    assert.equal(L.isDarkBg('255, 255, 255'), false);
    assert.equal(L.isDarkBg('25, 27, 31'), true); // Onyx center channel
    assert.equal(L.isDarkBg(''), false);
});

test('launch failures map to the approved panel states', () => {
    assert.equal(L.launchFailure(404), 'no-access');
    assert.equal(L.launchFailure(403), 'no-access');
    assert.equal(L.launchFailure(503), 'not-configured');
    assert.equal(L.launchFailure(500), 'unreachable');
    assert.equal(L.launchFailure(0), 'unreachable');
});

test('frame errors: closed sessions offer Reopen, boot failures Retry, the rest stay in the editor', () => {
    assert.equal(L.frameError('SESSION_CLOSED'), 'closed');
    assert.equal(L.frameError('NETWORK'), 'unreachable');
    assert.equal(L.frameError('HTTP_502'), 'unreachable');
    assert.equal(L.frameError('SAVE_FAILED'), null);
    assert.equal(L.frameError('CONFLICT'), null);
});

test('desktop app, permalink, meeting title, /canvas list', () => {
    assert.equal(L.isDesktopApp('Mozilla/5.0 ... Mattermost/5.12.0 Chrome/130 Electron/33'), true);
    assert.equal(L.isDesktopApp('Mozilla/5.0 Chrome/130 Safari/537.36'), false);
    assert.equal(L.permalink('https://chat.acme.example', '/', 'p1'), 'https://chat.acme.example/_redirect/pl/p1');
    assert.equal(L.permalink('https://acme.example', '/chat', 'p1'), 'https://acme.example/chat/_redirect/pl/p1');
    assert.equal(L.meetingTitle(new Date(2026, 10, 24)), 'Meeting notes 2026-11-24');
    assert.equal(L.isListCommand('/canvas list'), true);
    assert.equal(L.isListCommand('  /Canvas   LIST '), true);
    assert.equal(L.isListCommand('/canvas list all'), false);
    assert.equal(L.isListCommand('/canvas new list'), false);
});
