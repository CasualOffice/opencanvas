// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Placeholder for the right-hand panel (UI-SCREENS.md S2). It wires the real launch: a fresh
// token per open, form-POSTed into a named iframe so the token never sits in a URL
// (docs/05 §4 option A). Loading, error and no-access states are plain text until the
// approved design replaces them (ADR-011).

import * as React from 'react';

import {launchCanvas} from '../api';

let current = '';
const listeners = new Set<(id: string) => void>();

export function setPanelCanvas(fileId: string) {
    current = fileId;
    listeners.forEach((l) => l(fileId));
}

export function CanvasPanel() {
    const [fileId, setFileId] = React.useState(current);
    const [state, setState] = React.useState<'loading' | 'open' | 'no-access'>('loading');
    const form = React.useRef<HTMLFormElement>(null);
    const token = React.useRef<HTMLInputElement>(null);

    React.useEffect(() => {
        listeners.add(setFileId);
        return () => {
            listeners.delete(setFileId);
        };
    }, []);

    React.useEffect(() => {
        if (!fileId) {
            return;
        }
        let live = true;
        setState('loading');
        launchCanvas(fileId).then((l) => {
            if (!live) {
                return;
            }
            if (!l || !form.current || !token.current) {
                setState('no-access');
                return;
            }
            form.current.action = l.launchUrl;
            token.current.value = l.token;
            form.current.submit();
            token.current.value = '';
            setState('open');
        });
        return () => {
            live = false;
        };
    }, [fileId]);

    const frame = `opencanvas-${fileId || 'none'}`;
    return (
        <div style={{height: '100%'}}>
            {!fileId && <p>No canvas selected.</p>}
            {state === 'loading' && fileId && <p>Opening…</p>}
            {state === 'no-access' && <p>You don't have access to this canvas.</p>}
            <form ref={form} method='post' target={frame} style={{display: 'none'}}>
                <input ref={token} type='hidden' name='token'/>
            </form>
            <iframe
                name={frame}
                title='Canvas'
                style={{width: '100%', height: '100%', border: 0}}
                allow='clipboard-read; clipboard-write; fullscreen'
            />
        </div>
    );
}
