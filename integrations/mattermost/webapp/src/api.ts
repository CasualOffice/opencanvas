// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Calls to the plugin's server half. Mattermost authenticates them with the session cookie;
// a cookie-authenticated POST needs the CSRF token (cookie MMCSRF) in X-CSRF-Token.

const BASE = '/plugins/com.casualoffice.opencanvas/api/v1';

export interface CanvasRecord {
    id: string;
    channelId: string;
    title: string;
    template?: string;
    version: number;
    postId?: string;
}

export interface Launch {
    launchUrl: string;
    token: string;
    expiresAt: number;
    role: 'view' | 'comment' | 'edit';
}

function csrf(): string {
    const m = document.cookie.match(/(?:^|;\s*)MMCSRF=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const res = await fetch(BASE + path, {
        method,
        credentials: 'same-origin',
        headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'X-CSRF-Token': csrf(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
        return null;
    }
    return res.json() as Promise<T>;
}

export const createCanvas = (channelId: string, title: string, template: '' | 'meeting') =>
    call<CanvasRecord>('POST', '/canvases', {channelId, title, template});

export const launchCanvas = (fileId: string) =>
    call<Launch>('POST', `/canvases/${encodeURIComponent(fileId)}/launch`);

export const listChannelCanvases = (channelId: string) =>
    call<CanvasRecord[]>('GET', `/channels/${encodeURIComponent(channelId)}/canvases`);
