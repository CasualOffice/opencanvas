// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// S1 post card (`custom_opencanvas`), approved 2026-11-24. Actions sit on the title row
// (S1i) and the whole card opens the canvas. States: loading (S1d top), normal (S1a, S1c),
// no access, deleted (S1d), selected while open in the panel (S1e), narrow (S1f).

import * as React from 'react';
import {Download, Ellipsis, FileText, FileX, Link, Lock, Maximize2, NotebookPen, Pencil} from 'lucide-react';

import type {Post} from '../index';
import {cardMeta, kindLabel, kindOf, permalink} from '../logic';
import {clock, dialog, infoCell, panel, startClock, useCell} from '../store';
import {copyText} from './copy';

export interface CardActions {
    open(fileId: string): void;
    openExpanded(fileId: string): void;
}

export function KindIcon({template, size = 20}: {template?: string; size?: number}) {
    return kindOf(template) === 'meeting' ? <NotebookPen size={size} strokeWidth={1.75} aria-hidden='true'/> : <FileText size={size} strokeWidth={1.75} aria-hidden='true'/>;
}

// The menu is portalled to <body> with fixed coordinates: inside the post it was drawn under
// the next post (each post is its own stacking context; seen in the real-host run).
const portal = (el: React.ReactElement) => {
    const RD = (window as unknown as {ReactDOM?: {createPortal(n: React.ReactNode, c: Element): React.ReactElement}}).ReactDOM;
    return RD ? RD.createPortal(el, document.body) : el;
};

function Menu({anchor, onClose, children}: {anchor: HTMLElement | null; onClose: () => void; children: React.ReactNode}) {
    const ref = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        const away = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node) && !anchor?.contains(e.target as Node)) {
                onClose();
            }
        };
        const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
        document.addEventListener('mousedown', away);
        document.addEventListener('keydown', key);
        ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
        return () => {
            document.removeEventListener('mousedown', away);
            document.removeEventListener('keydown', key);
        };
    }, [onClose, anchor]);
    const r = anchor?.getBoundingClientRect();
    const below = !r || r.bottom + 220 < window.innerHeight;
    return portal(
        <div
            ref={ref}
            className='oc oc-menu'
            role='menu'
            style={{position: 'fixed', right: r ? window.innerWidth - r.right : 16, ...(below ? {top: (r?.bottom ?? 0) + 4} : {bottom: window.innerHeight - r.top + 4})}}
            onClick={(e) => e.stopPropagation()}
        >{children}</div>,
    );
}

export function CanvasPost({post, actions}: {post: Post; actions: CardActions}) {
    const fileId = String(post.props.opencanvas_file_id ?? '');
    const propTitle = String(post.props.opencanvas_title ?? 'Canvas');
    const template = String(post.props.opencanvas_template ?? '');
    const live = useCell(infoCell(fileId));
    const now = useCell(clock);
    const p = useCell(panel);
    const [menu, setMenu] = React.useState(false);
    const more = React.useRef<HTMLButtonElement>(null);
    React.useEffect(startClock, []);

    const info = live.state === 'ok' ? live.info : null;
    const title = info?.title ?? propTitle;

    if (live.state === 'no-access' || live.state === 'gone') {
        const gone = live.state === 'gone';
        return (
            <div className='oc oc-card static' data-state={live.state}>
                <span className='oc-tile mute'>{gone ? <FileX size={20} strokeWidth={1.75} aria-hidden='true'/> : <Lock size={20} strokeWidth={1.75} aria-hidden='true'/>}</span>
                <div className='oc-body'>
                    <div className='oc-title'>{title}</div>
                    <div className='oc-meta'>{gone ? 'This canvas is no longer available' : `${kindLabel(template)} · You don't have access to this canvas`}</div>
                </div>
            </div>
        );
    }

    const open = () => actions.open(fileId);
    const selected = p.mounted && p.view === 'canvas' && p.fileId === fileId;
    const stop = (f: () => void) => (e: React.MouseEvent) => {
        e.stopPropagation();
        f();
    };
    const link = () => permalink(window.location.origin, (window as unknown as {basename?: string}).basename ?? '', post.id);

    return (
        <div
            className={'oc oc-card' + (selected ? ' sel' : '')}
            data-state={live.state}
            onClick={(e) => {
                // Mattermost opens the reply thread on a click in a post; the card opens the canvas.
                e.stopPropagation();
                open();
            }}
            onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                    e.preventDefault();
                    open();
                }
            }}
            tabIndex={0}
            role='group'
            aria-label={`${kindLabel(template)}: ${title}`}
        >
            <span className='oc-tile'><KindIcon template={template}/></span>
            <div className='oc-body'>
                <div className='oc-titlerow'>
                    <div className='oc-titles'>
                        <div className='oc-title'>{title}</div>
                        <div className='oc-meta'>
                            {info ? cardMeta(info, now) : (
                                <>{kindLabel(template)} · <span className='oc-skel' style={{width: 90}}/></>
                            )}
                        </div>
                    </div>
                    <div className='oc-acts' style={{position: 'relative'}}>
                        <button type='button' className='oc-btn pri' onClick={stop(open)}>{'Open'}</button>
                        <button
                            type='button'
                            className='oc-ib oc-expand'
                            aria-label='Open expanded'
                            title='Open expanded'
                            onClick={stop(() => actions.openExpanded(fileId))}
                        ><Maximize2 size={16} strokeWidth={1.75} aria-hidden='true'/></button>
                        <button
                            type='button'
                            className='oc-ib'
                            ref={more}
                            aria-label='More actions'
                            title='More actions'
                            aria-haspopup='menu'
                            aria-expanded={menu}
                            onClick={stop(() => setMenu(!menu))}
                        ><Ellipsis size={16} strokeWidth={1.75} aria-hidden='true'/></button>
                        {menu && (
                            <Menu anchor={more.current} onClose={() => setMenu(false)}>
                                <button
                                    type='button'
                                    role='menuitem'
                                    className='oc-mi'
                                    onClick={() => {
                                        setMenu(false);
                                        actions.openExpanded(fileId);
                                    }}
                                ><Maximize2 size={16} strokeWidth={1.75} aria-hidden='true'/>{'Open expanded'}</button>
                                <button
                                    type='button'
                                    role='menuitem'
                                    className='oc-mi'
                                    onClick={() => {
                                        setMenu(false);
                                        void copyText(link());
                                    }}
                                ><Link size={16} strokeWidth={1.75} aria-hidden='true'/>{'Copy link'}</button>
                                {info?.canEdit && (
                                    <button
                                        type='button'
                                        role='menuitem'
                                        className='oc-mi'
                                        onClick={() => {
                                            setMenu(false);
                                            dialog.set({kind: 'rename', fileId, title});
                                        }}
                                    ><Pencil size={16} strokeWidth={1.75} aria-hidden='true'/>{'Rename'}</button>
                                )}
                                <div className='oc-msep' role='separator'/>
                                <button
                                    type='button'
                                    role='menuitem'
                                    className='oc-mi'
                                    disabled={true}
                                    aria-disabled='true'
                                ><Download size={16} strokeWidth={1.75} aria-hidden='true'/>{'Download .ocanvas'}<span className='oc-later'>{'Later'}</span></button>
                            </Menu>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
