// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Calls to the plugin's server half. Mattermost authenticates them with the session cookie;
// a cookie-authenticated POST needs the CSRF token (cookie MMCSRF) in X-CSRF-Token.

export const PLUGIN_ID = 'com.casualoffice.opencanvas';

function base(): string {
    const b = ((window as unknown as {basename?: string}).basename ?? '').replace(/\/$/, '');
    return `${b}/plugins/${PLUGIN_ID}`;
}

export interface CanvasRecord {
    id: string;
    channelId: string;
    title: string;
    template?: string;
    version: number;
    postId?: string;
    createdAt: number;
    updatedAt: number;
}

export interface CanvasInfo extends CanvasRecord {
    canEdit: boolean;
    role: 'view' | 'comment' | 'edit';
}

export interface Launch {
    launchUrl: string;
    token: string;
    expiresAt: number;
    role: 'view' | 'comment' | 'edit';
}

/** A call's answer: the JSON body, or the HTTP status (0 = network failure). */
export type Result<T> = {ok: true; data: T} | {ok: false; status: number; code?: string};

function csrf(): string {
    const m = document.cookie.match(/(?:^|;\s*)MMCSRF=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
}

async function call<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
    let res: Response;
    try {
        res = await fetch(base() + '/api/v1' + path, {
            method,
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRF-Token': csrf(),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch {
        return {ok: false, status: 0};
    }
    if (!res.ok) {
        let code: string | undefined;
        try {
            code = (await res.json())?.error;
        } catch {
            // not JSON
        }
        return {ok: false, status: res.status, code};
    }
    return {ok: true, data: (await res.json()) as T};
}

export const createCanvas = (channelId: string, title: string, template: '' | 'meeting') =>
    call<CanvasRecord>('POST', '/canvases', {channelId, title, template});

export const launchCanvas = (fileId: string) =>
    call<Launch>('POST', `/canvases/${encodeURIComponent(fileId)}/launch`);

export const canvasInfo = (fileId: string) =>
    call<CanvasInfo>('GET', `/canvases/${encodeURIComponent(fileId)}`);

export const renameCanvas = (fileId: string, title: string) =>
    call<CanvasInfo>('PATCH', `/canvases/${encodeURIComponent(fileId)}`, {title});

export const listChannelCanvases = (channelId: string) =>
    call<CanvasRecord[]>('GET', `/channels/${encodeURIComponent(channelId)}/canvases`);

/** "Open in new window" (S2) / "Open in your browser" (S7b): a page that launches with the session. */
export const openPageUrl = (fileId: string) =>
    `${window.location.origin}${base()}/open/${encodeURIComponent(fileId)}`;
