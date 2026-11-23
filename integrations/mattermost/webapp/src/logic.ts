// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Pure helpers behind the approved screens (MM-02). No React, no DOM: unit-tested in
// test/logic.test.mjs.

export type Kind = 'canvas' | 'meeting';

export const kindOf = (template?: string): Kind => (template === 'meeting' ? 'meeting' : 'canvas');
export const kindLabel = (template?: string) => (kindOf(template) === 'meeting' ? 'Meeting notes' : 'Canvas');

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "just now", "4 min ago", "1 hour ago", "yesterday", "last Monday", "Nov 10", "Nov 10, 2025". */
export function relTime(at: number, now: number): string {
    const s = Math.max(0, (now - at) / 1000);
    if (s < 45) {
        return 'just now';
    }
    if (s < 3600) {
        return `${Math.max(1, Math.round(s / 60))} min ago`;
    }
    const a = new Date(at);
    const n = new Date(now);
    if (s < 86400 && a.getDate() === n.getDate()) {
        const h = Math.floor(s / 3600);
        return `${h} hour${h === 1 ? '' : 's'} ago`;
    }
    const day = (d: Date) => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000);
    const days = day(n) - day(a);
    if (days <= 1) {
        return days === 1 ? 'yesterday' : `${Math.floor(s / 3600)} hours ago`;
    }
    if (days < 7) {
        return `last ${WEEKDAYS[a.getDay()]}`;
    }
    const md = `${MONTHS[a.getMonth()]} ${a.getDate()}`;
    return a.getFullYear() === n.getFullYear() ? md : `${md}, ${a.getFullYear()}`;
}

/** The card's second line (S1a, S1c): "Canvas · Edited 4 min ago", or "Created" before the first save. */
export function cardMeta(info: {template?: string; version: number; createdAt: number; updatedAt: number}, now: number): string {
    const edited = info.version > 0;
    return `${kindLabel(info.template)} · ${edited ? 'Edited' : 'Created'} ${relTime(edited ? info.updatedAt : info.createdAt, now)}`;
}

/** Mattermost themes set `--center-channel-bg-rgb` ("255, 255, 255"); dark when its luminance is low. */
export function isDarkBg(rgb: string): boolean {
    const p = rgb.split(',').map((x) => Number(x.trim()));
    if (p.length < 3 || p.some((x) => !Number.isFinite(x))) {
        return false;
    }
    const lin = (c: number) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]) < 0.2;
}

/** What the panel shows for a launch answer (S2k, S2l, S2m, S2n). */
export type LaunchFailure = 'no-access' | 'not-configured' | 'unreachable';
export function launchFailure(status: number): LaunchFailure {
    if (status === 404 || status === 403) {
        return 'no-access';
    }
    if (status === 503) {
        return 'not-configured';
    }
    return 'unreachable';
}

/** What the panel does with an `Error` message from the canvas frame. */
export function frameError(code: unknown): 'closed' | 'unreachable' | null {
    if (code === 'SESSION_CLOSED') {
        return 'closed';
    }
    if (typeof code === 'string' && (code === 'NETWORK' || code === 'TICKET_INVALID' || code.startsWith('HTTP_'))) {
        return 'unreachable';
    }
    return null; // SAVE_FAILED, CONFLICT, ...: the editor shows them itself
}

/** The Mattermost Desktop app runs the web app with "Mattermost/x.y" in its user agent. */
export const isDesktopApp = (ua: string) => /\bMattermost\/\d/.test(ua);

/** The card's permalink: Mattermost resolves `/_redirect/pl/<postId>` to the post in its team. */
export function permalink(origin: string, basename: string, postId: string): string {
    return `${origin}${basename.replace(/\/$/, '')}/_redirect/pl/${encodeURIComponent(postId)}`;
}

/** "Meeting notes 2026-11-24": the default title of meeting notes (S3c), in local time. */
export function meetingTitle(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `Meeting notes ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Whether `/canvas list` (with any spacing or case) should open the list panel (S4). */
export const isListCommand = (msg: string) => /^\/canvas\s+list\s*$/i.test(msg.trim());
