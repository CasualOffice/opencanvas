// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The plugin's own UI state (which canvas the panel shows, open dialogs, the cards' live info)
// and the few things it reads from Mattermost's Redux store.

import * as React from 'react';

import {canvasInfo, type CanvasInfo} from './api';

type Listener = () => void;

class Cell<T> {
    private fns = new Set<Listener>();
    constructor(private v: T) {}
    get = () => this.v;
    set = (v: T) => {
        this.v = v;
        this.fns.forEach((f) => f());
    };
    sub = (f: Listener) => {
        this.fns.add(f);
        return () => {
            this.fns.delete(f);
        };
    };
}

export function useCell<T>(c: Cell<T>): T {
    const [, force] = React.useState(0);
    React.useEffect(() => c.sub(() => force((n) => n + 1)), [c]);
    return c.get();
}

// ---------------------------------------------------------------- panel

export interface PanelState {
    view: 'canvas' | 'list';
    fileId: string;
    /** Bumped to relaunch the same canvas (Retry, Reopen, a new canvas). */
    nonce: number;
    /** Whether the right-hand panel is showing our component (the card's selection ring). */
    mounted: boolean;
}
export const panel = new Cell<PanelState>({view: 'canvas', fileId: '', nonce: 0, mounted: false});

export function showCanvas(fileId: string) {
    const p = panel.get();
    panel.set({...p, view: 'canvas', fileId, nonce: p.nonce + 1});
}
export function showList() {
    panel.set({...panel.get(), view: 'list'});
}

// ---------------------------------------------------------------- dialogs

export type Dialog =
    | null
    | {kind: 'create'; channelId: string}
    | {kind: 'rename'; fileId: string; title: string}
    | {kind: 'copy'; url: string};
export const dialog = new Cell<Dialog>(null);

// ---------------------------------------------------------------- live card info (S1)

export type CardInfo = {state: 'loading'} | {state: 'ok'; info: CanvasInfo} | {state: 'no-access'} | {state: 'gone'} | {state: 'error'};
const infos = new Map<string, Cell<CardInfo>>();

export function infoCell(fileId: string): Cell<CardInfo> {
    let c = infos.get(fileId);
    if (!c) {
        c = new Cell<CardInfo>({state: 'loading'});
        infos.set(fileId, c);
        if (/^mm_/.test(fileId)) {
            void refreshInfo(fileId);
        }
    }
    return c;
}

export async function refreshInfo(fileId: string) {
    const c = infos.get(fileId);
    if (!c) {
        return;
    }
    const r = await canvasInfo(fileId);
    if (r.ok) {
        c.set({state: 'ok', info: r.data});
    } else if (r.status === 404) {
        c.set({state: 'gone'});
    } else if (r.status === 403) {
        c.set({state: 'no-access'});
    } else if (c.get().state === 'loading') {
        c.set({state: 'error'});
    }
}

/** A save or rename elsewhere (plugin WebSocket event `canvas_updated`). */
export function onCanvasUpdated(data: {fileId?: string; title?: string; updatedAt?: number; version?: number}) {
    const c = data.fileId ? infos.get(data.fileId) : undefined;
    const cur = c?.get();
    if (c && cur?.state === 'ok') {
        c.set({state: 'ok', info: {...cur.info, title: data.title ?? cur.info.title, updatedAt: data.updatedAt ?? cur.info.updatedAt, version: data.version ?? cur.info.version}});
    }
    listVersion.set(listVersion.get() + 1);
}

/** Bumped when any canvas changes, so an open list reloads. */
export const listVersion = new Cell(0);

/** A clock for relative times ("Edited 4 min ago"), ticking every 30 s while something shows it. */
export const clock = new Cell(Date.now());
let ticking = false;
export function startClock() {
    if (!ticking) {
        ticking = true;
        window.setInterval(() => clock.set(Date.now()), 30_000);
    }
}

// ---------------------------------------------------------------- Mattermost store

export interface MMState {
    entities: {
        channels: {currentChannelId: string; channels: Record<string, {id: string; name: string; display_name: string; type: string}>};
        users: {currentUserId: string; profiles: Record<string, {roles?: string}>};
    };
}
export interface MMStore {
    dispatch(action: unknown): unknown;
    getState(): MMState;
    subscribe(fn: () => void): () => void;
}

let mm: MMStore | null = null;
export const setMM = (s: MMStore) => {
    mm = s;
};
export const mmStore = () => mm;

export function currentChannelId(): string {
    return mm?.getState().entities.channels.currentChannelId ?? '';
}
export function channelName(id: string): string {
    const ch = mm?.getState().entities.channels.channels[id];
    return ch?.name ?? '';
}
export function isSystemAdmin(): boolean {
    const st = mm?.getState();
    if (!st) {
        return false;
    }
    const me = st.entities.users.profiles[st.entities.users.currentUserId];
    return (me?.roles ?? '').split(' ').includes('system_admin');
}

/** Re-renders on Mattermost store changes that matter to us (the current channel). */
export function useCurrentChannel(): string {
    const [id, setId] = React.useState(currentChannelId());
    React.useEffect(() => mm?.subscribe(() => setId(currentChannelId())), []);
    return id;
}
