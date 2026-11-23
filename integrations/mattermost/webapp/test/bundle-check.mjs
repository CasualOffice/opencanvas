// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Loads dist/main.js the way Mattermost does (a plain <script> with window.React present, no
// `require`) and checks that the plugin registers itself and its components.
//
//   npm run build && npm test
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../dist/main.js', import.meta.url), 'utf8');
assert.ok(!src.includes('("react")'), 'bundle must not require("react"): use window.React');

const calls = [];
const React = {
    createElement: (...a) => ({el: a}),
    forwardRef: (f) => f,
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useRef: () => ({current: null}),
};
let registered;
const window = {
    React,
    registerPlugin: (id, plugin) => {
        registered = {id, plugin};
    },
};
vm.runInNewContext(src, {window, document: {cookie: ''}, console});
assert.equal(registered?.id, 'com.casualoffice.opencanvas');

const registry = new Proxy({}, {
    get: (_, name) => (...args) => {
        calls.push(name);
        return name === 'registerRightHandSidebarComponent' ? {id: 'rhs', showRHSPlugin: {type: 'show'}} : 'id';
    },
});
registered.plugin.initialize(registry, {dispatch: () => {}});
assert.deepEqual(calls.sort(), [
    'registerChannelHeaderButtonAction',
    'registerPostTypeComponent',
    'registerRightHandSidebarComponent',
]);
console.log('bundle-check: ok,', calls.length, 'registrations');
