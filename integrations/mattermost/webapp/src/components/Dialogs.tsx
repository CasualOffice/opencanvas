// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// S3 create dialog (approved 2026-11-24) and the Rename dialog from the card menu (S1b),
// drawn the same way. Rendered by a root component so they sit above Mattermost's layout.

import * as React from 'react';
import {CircleAlert, FileText, NotebookPen, UsersRound, X} from 'lucide-react';

import {createCanvas, renameCanvas} from '../api';
import {meetingTitle} from '../logic';
import {channelName, dialog, refreshInfo, useCell} from '../store';
import {CopyFallback} from './copy';

function Shell({label, onClose, children}: {label: string; onClose: () => void; children: React.ReactNode}) {
    React.useEffect(() => {
        const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
        document.addEventListener('keydown', key);
        return () => document.removeEventListener('keydown', key);
    }, [onClose]);
    return (
        <div className='oc oc-overlay' onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div className='oc-dialog' role='dialog' aria-modal='true' aria-label={label}>
                <button type='button' className='oc-ib oc-x' aria-label='Close' onClick={onClose}><X size={20} strokeWidth={1.75} aria-hidden='true'/></button>
                {children}
            </div>
        </div>
    );
}

function CreateDialog({channelId, onCreated}: {channelId: string; onCreated: (fileId: string) => void}) {
    const [title, setTitle] = React.useState('');
    const [kind, setKind] = React.useState<'' | 'meeting'>('');
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const input = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => input.current?.focus(), []);
    const close = React.useCallback(() => dialog.set(null), []);
    const name = channelName(channelId);

    const submit = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (busy) {
            return;
        }
        setBusy(true);
        setError('');
        const r = await createCanvas(channelId, title, kind);
        setBusy(false);
        if (r.ok) {
            dialog.set(null);
            onCreated(r.data.id);
        } else {
            setError(r.status === 403 ? "You can't create a canvas in this channel." : "Couldn't create the canvas. Try again.");
        }
    };

    const opt = (value: '' | 'meeting', icon: React.ReactNode, t: string, d: string) => (
        <label className={'oc-opt' + (kind === value ? ' on' : '')}>
            <input type='radio' name='oc-kind' checked={kind === value} onChange={() => setKind(value)}/>
            <span className='oc-tile md'>{icon}</span>
            <span>
                <span className='oc-o1' style={{display: 'block'}}>{t}</span>
                <span className='oc-o2' style={{display: 'block'}}>{d}</span>
            </span>
            <span className='oc-radio' aria-hidden='true'/>
        </label>
    );

    return (
        <Shell label='Create canvas' onClose={close}>
            <form onSubmit={submit}>
                <div className='oc-dhead'>
                    <h1>{'Create canvas'}</h1>
                    {name && <span className='oc-dch'>{`# ${name}`}</span>}
                </div>
                <div className='oc-field'>
                    <input
                        ref={input}
                        id='oc-title'
                        value={title}
                        maxLength={120}
                        placeholder={kind === 'meeting' ? meetingTitle(new Date()) : 'Untitled canvas'}
                        onChange={(e) => setTitle(e.target.value)}
                        disabled={busy}
                    />
                    <label htmlFor='oc-title'>{'Title (optional)'}</label>
                </div>
                <div className='oc-opts' role='radiogroup' aria-label='Kind'>
                    {opt('', <FileText size={18} strokeWidth={1.75} aria-hidden='true'/>, 'Blank canvas', 'An empty page for notes, tables, boards and more.')}
                    {opt('meeting', <NotebookPen size={18} strokeWidth={1.75} aria-hidden='true'/>, 'Meeting notes', 'Starts with Agenda, Notes, Decisions and Action items.')}
                </div>
                <div className='oc-note'>
                    <UsersRound size={16} strokeWidth={1.75} aria-hidden='true'/>
                    <span>{'Everyone in '}<b>{name ? `~${name}` : 'this channel'}</b>{" can open and edit it. It's saved in Mattermost."}</span>
                </div>
                {error && (
                    <div className='oc-err' role='alert'>
                        <CircleAlert size={16} strokeWidth={1.75} aria-hidden='true'/>
                        <span>{error}</span>
                    </div>
                )}
                <div className='oc-dfoot'>
                    <button type='button' className='oc-btn lg ter' onClick={close}>{'Cancel'}</button>
                    <button type='submit' className='oc-btn lg pri' disabled={busy} aria-busy={busy}>{busy ? 'Creating…' : 'Create'}</button>
                </div>
            </form>
        </Shell>
    );
}

function RenameDialog({fileId, initial}: {fileId: string; initial: string}) {
    const [title, setTitle] = React.useState(initial);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const input = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => {
        input.current?.focus();
        input.current?.select();
    }, []);
    const close = React.useCallback(() => dialog.set(null), []);
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (busy || !title.trim()) {
            return;
        }
        setBusy(true);
        setError('');
        const r = await renameCanvas(fileId, title);
        setBusy(false);
        if (r.ok) {
            dialog.set(null);
            void refreshInfo(fileId);
        } else {
            setError(r.status === 403 ? "You can't rename this canvas." : "Couldn't rename the canvas. Try again.");
        }
    };
    return (
        <Shell label='Rename canvas' onClose={close}>
            <form onSubmit={submit}>
                <div className='oc-dhead'><h1>{'Rename canvas'}</h1></div>
                <div className='oc-field'>
                    <input ref={input} id='oc-rename' value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} disabled={busy}/>
                    <label htmlFor='oc-rename'>{'Title'}</label>
                </div>
                {error && (
                    <div className='oc-err' role='alert'>
                        <CircleAlert size={16} strokeWidth={1.75} aria-hidden='true'/>
                        <span>{error}</span>
                    </div>
                )}
                <div className='oc-dfoot'>
                    <button type='button' className='oc-btn lg ter' onClick={close}>{'Cancel'}</button>
                    <button type='submit' className='oc-btn lg pri' disabled={busy || !title.trim()}>{busy ? 'Saving…' : 'Save'}</button>
                </div>
            </form>
        </Shell>
    );
}

/** registerRootComponent: the dialogs, and the copy fallback when the panel is closed. */
export function makeRoot(onCreated: (fileId: string) => void, panelOpen: () => boolean) {
    return function Root() {
        const d = useCell(dialog);
        if (d?.kind === 'create') {
            return <CreateDialog key={d.channelId} channelId={d.channelId} onCreated={onCreated}/>;
        }
        if (d?.kind === 'rename') {
            return <RenameDialog key={d.fileId} fileId={d.fileId} initial={d.title}/>;
        }
        if (d?.kind === 'copy' && !panelOpen()) {
            return <CopyFallback inPanel={false}/>;
        }
        return null;
    };
}
