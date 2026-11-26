// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// S2 canvas panel (right-hand sidebar) and S4 channel canvases list, approved 2026-11-24.
// The launch is a fresh token per open, form-POSTed into a named iframe so the token never
// sits in a URL (docs/05 §4 option A). Mattermost draws the header's Expand and Close; the
// title node (PanelTitle) adds the canvas name, channel, Canvases and Open in new window.

import * as React from 'react';
import {Ban, CloudOff, ExternalLink, FileText, Info, LayoutGrid, Lock, Plus, RotateCcw, Settings, type LucideIcon} from 'lucide-react';

import {PLUGIN_ID, launchCanvas, listChannelCanvases, openPageUrl, type CanvasRecord} from '../api';
import {cardMeta, frameError, isDarkBg, isDesktopApp, launchFailure, permalink, type LaunchFailure} from '../logic';
import {
    channelName, clock, currentChannelId, dialog, infoCell, isSystemAdmin, listVersion, mmStore, panel, showCanvas,
    startClock, useCell, useCurrentChannel,
} from '../store';
import {KindIcon} from './CanvasPost';
import {copyText, CopyFallback} from './copy';

const FRAME = 'opencanvas-frame'; // one stable name (MM-01: a changing name broke switching)
const READY_TIMEOUT_MS = 20_000;
const SKELETON_DELAY_MS = 300;

const icon = (C: LucideIcon, size = 16) => <C size={size} strokeWidth={1.75} aria-hidden='true'/>;

function theme(): 'light' | 'dark' {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--center-channel-bg-rgb');
    return isDarkBg(v) ? 'dark' : 'light';
}

function goToSettings() {
    const path = `/admin_console/plugins/plugin_${PLUGIN_ID}`;
    const h = (window as unknown as {WebappUtils?: {browserHistory?: {push(p: string): void}}}).WebappUtils?.browserHistory;
    if (h) {
        h.push(path);
    } else {
        window.location.assign(path);
    }
}

// ---------------------------------------------------------------- header (title node)

export function PanelTitle() {
    const p = useCell(panel);
    const ch = useCurrentChannel();
    const live = useCell(infoCell(p.fileId || '_none'));
    const desktop = isDesktopApp(navigator.userAgent);
    if (p.view === 'list' || !p.fileId) {
        return (
            <span className='oc oc-ptitle'>
                <span className='oc-names'><span className='oc-n1'>{'Canvases'}</span></span>
                <span className='oc-n2' style={{fontSize: 12}}>{channelName(ch) ? `# ${channelName(ch)}` : ''}</span>
            </span>
        );
    }
    const info = live.state === 'ok' ? live.info : null;
    const chName = info ? channelName(info.channelId) : '';
    const openOut = desktop ? 'Open in your browser' : 'Open in new window';
    return (
        <span className='oc oc-ptitle'>
            <span className='oc-tile sm'><KindIcon template={info?.template} size={16}/></span>
            <span className='oc-names'>
                <span className='oc-n1' style={{display: 'block'}}>{info?.title ?? 'Canvas'}</span>
                {chName && <span className='oc-n2' style={{display: 'block'}}>{`# ${chName}`}</span>}
            </span>
            <span className='oc-hacts'>
                <button
                    type='button'
                    className='oc-ib'
                    aria-label='Channel canvases'
                    title='Channel canvases'
                    onClick={() => panel.set({...panel.get(), view: 'list'})}
                >{icon(LayoutGrid)}</button>
                <button
                    type='button'
                    className='oc-ib'
                    aria-label={openOut}
                    title={openOut}
                    onClick={() => window.open(openPageUrl(p.fileId), '_blank', 'noopener')}
                >{icon(ExternalLink)}</button>
            </span>
        </span>
    );
}

// ---------------------------------------------------------------- body

export interface PanelHost {
    hide(): void;
}

export function CanvasPanel({host}: {host: PanelHost}) {
    const p = useCell(panel);
    React.useEffect(() => {
        panel.set({...panel.get(), mounted: true});
        return () => panel.set({...panel.get(), mounted: false});
    }, []);
    return (
        <div className='oc oc-panel'>
            {p.view === 'list' ? <ChannelList/> : <CanvasView fileId={p.fileId} nonce={p.nonce} host={host}/>}
            <CopyFallback inPanel={true}/>
        </div>
    );
}

type View = 'idle' | 'opening' | 'open' | LaunchFailure;

function Skeleton() {
    return (
        <div className='oc-skelpage' aria-hidden='true'>
            <div className='oc-skbar'>
                <span className='oc-sk' style={{width: 22, height: 22}}/>
                <span className='oc-sk' style={{width: 150, height: 12}}/>
                <span className='oc-sk' style={{width: 60, height: 22, marginLeft: 'auto', borderRadius: 11}}/>
            </div>
            <div style={{padding: '22px 18px'}}>
                <div className='oc-sk' style={{width: 225, height: 34, marginBottom: 14}}/>
                <div className='oc-sk' style={{width: 130, height: 10, marginBottom: 28}}/>
                <div className='oc-sk' style={{width: 88, height: 12, marginBottom: 16}}/>
                <div className='oc-sk' style={{width: '88%', height: 10, marginBottom: 10}}/>
                <div className='oc-sk' style={{width: '76%', height: 10, marginBottom: 10}}/>
                <div className='oc-sk' style={{width: '54%', height: 10, marginBottom: 28}}/>
                <div className='oc-sk' style={{width: '100%', height: 150, borderRadius: 10}}/>
            </div>
        </div>
    );
}

function State({tile, title, text, children}: {tile: React.ReactNode; title: string; text: string; children?: React.ReactNode}) {
    return (
        <div className='oc-state' role='status'>
            <span className='oc-tile mute'>{tile}</span>
            <h2>{title}</h2>
            <p>{text}</p>
            {children}
        </div>
    );
}

function CanvasView({fileId, nonce, host}: {fileId: string; nonce: number; host: PanelHost}) {
    const [view, setView] = React.useState<View>(fileId ? 'opening' : 'idle');
    const [loaded, setLoaded] = React.useState(false);
    const [skeleton, setSkeleton] = React.useState(false);
    const [closed, setClosed] = React.useState(false);
    const form = React.useRef<HTMLFormElement>(null);
    const token = React.useRef<HTMLInputElement>(null);
    const frame = React.useRef<HTMLIFrameElement>(null);
    const ocOrigin = React.useRef('');
    const live = useCell(infoCell(fileId || '_none'));
    const postId = live.state === 'ok' ? live.info.postId : undefined;
    const postIdRef = React.useRef(postId);
    postIdRef.current = postId;

    const send = React.useCallback((MessageId: string, Values: Record<string, unknown> = {}) => {
        const w = frame.current?.contentWindow;
        if (w && ocOrigin.current) {
            w.postMessage({MessageId, SendTime: Date.now(), Values}, ocOrigin.current);
        }
    }, []);

    // Launch: on a new canvas, Retry and Reopen (nonce).
    React.useEffect(() => {
        if (!fileId) {
            setView('idle');
            return undefined;
        }
        let live = true;
        setView('opening');
        setLoaded(false);
        setClosed(false);
        setSkeleton(false);
        const skel = window.setTimeout(() => live && setSkeleton(true), SKELETON_DELAY_MS);
        let ready: number | undefined;
        launchCanvas(fileId).then((r) => {
            if (!live) {
                return;
            }
            if (!r.ok) {
                setView(launchFailure(r.status));
                return;
            }
            if (!form.current || !token.current) {
                return;
            }
            ocOrigin.current = new URL(r.data.launchUrl).origin;
            form.current.action = r.data.launchUrl;
            token.current.value = r.data.token;
            form.current.submit();
            token.current.value = '';
            setView('open');
            ready = window.setTimeout(() => live && setView((v) => (v === 'open' ? 'unreachable' : v)), READY_TIMEOUT_MS);
            readyTimer.current = ready;
        });
        return () => {
            live = false;
            window.clearTimeout(skel);
            window.clearTimeout(ready);
        };
    }, [fileId, nonce]);
    const readyTimer = React.useRef<number | undefined>(undefined);

    // Messages from the canvas frame (docs/05 §4 postMessage API).
    React.useEffect(() => {
        const onMsg = (e: MessageEvent) => {
            if (e.source !== frame.current?.contentWindow || e.origin !== ocOrigin.current) {
                return;
            }
            const m = e.data as {MessageId?: string; Values?: Record<string, unknown>};
            const v = m?.Values ?? {};
            switch (m?.MessageId) {
            case 'App_LoadingStatus':
                window.clearTimeout(readyTimer.current);
                if (v.Status === 'Frame_Ready') {
                    send('Host_PostmessageReady');
                    send('Action_Theme', {theme: theme()});
                } else if (v.Status === 'Document_Loaded') {
                    // Again here: at Frame_Ready the editor has not subscribed to Action_Theme yet
                    // (the frame kept its own theme in the real-host run).
                    send('Action_Theme', {theme: theme()});
                    setLoaded(true);
                }
                break;
            case 'Error': {
                const what = frameError(v.code);
                if (what === 'closed') {
                    setClosed(true);
                } else if (what === 'unreachable') {
                    setView('unreachable');
                }
                break;
            }
            case 'UI_BlockLink': {
                // Mattermost has no block anchors: the link is the card's permalink (S7a).
                const pid = postIdRef.current;
                if (pid) {
                    void copyText(permalink(window.location.origin, (window as unknown as {basename?: string}).basename ?? '', pid));
                }
                break;
            }
            case 'UI_Link_Click':
                if (typeof v.url === 'string' && /^https?:/i.test(v.url)) {
                    window.open(v.url, '_blank', 'noopener');
                }
                break;
            case 'UI_Close':
                host.hide();
                break;
            }
        };
        window.addEventListener('message', onMsg);
        return () => window.removeEventListener('message', onMsg);
    }, [send, host]);

    // Follow Mattermost's theme while the canvas is open (Action_Theme).
    React.useEffect(() => {
        let last = theme();
        const s = mmStore();
        return s?.subscribe(() => {
            const t = theme();
            if (t !== last) {
                last = t;
                send('Action_Theme', {theme: t});
            }
        });
    }, [send]);

    const retry = () => showCanvas(fileId);
    const admin = isSystemAdmin();
    let body: React.ReactNode = null;
    switch (view) {
    case 'idle':
        body = <State tile={icon(FileText, 20)} title='No canvas open' text='Open a canvas from its card in the channel.'/>;
        break;
    case 'no-access':
        body = <State tile={icon(Lock, 20)} title="You don't have access to this canvas" text='Ask someone in the channel to add you.'/>;
        break;
    case 'not-configured':
        body = admin ? (
            <State tile={icon(Settings, 20)} title="OpenCanvas isn't set up" text='The plugin needs its OpenCanvas URL and secrets before canvases can open.'>
                <button type='button' className='oc-btn pri' onClick={goToSettings}>{'Open plugin settings'}</button>
            </State>
        ) : (
            <State tile={icon(Ban, 20)} title="Canvases aren't available right now" text="Try again later. If it keeps happening, tell your Mattermost admin."/>
        );
        break;
    case 'unreachable':
        body = (
            <State tile={icon(CloudOff, 20)} title="Can't reach the canvas server" text='Check your connection, then try again.'>
                <button type='button' className='oc-btn pri' onClick={retry}>{icon(RotateCcw, 14)}{'Retry'}</button>
            </State>
        );
        break;
    }
    const showFrame = view === 'open' || view === 'opening';
    return (
        <>
            <form ref={form} method='post' target={FRAME} style={{display: 'none'}}>
                <input ref={token} type='hidden' name='token'/>
            </form>
            <div style={{position: 'relative', flex: 1, minHeight: 0, display: showFrame ? 'flex' : 'none', flexDirection: 'column'}}>
                <iframe
                    ref={frame}
                    name={FRAME}
                    title='Canvas'
                    className={'oc-frame' + (loaded ? '' : ' hide')}
                    allow='clipboard-read; clipboard-write; fullscreen'
                />
                {!loaded && skeleton && <Skeleton/>}
                {closed && <div className='oc-scrim' aria-hidden='true'/>}
            </div>
            {body}
            {closed && showFrame && (
                <div className='oc-foot' role='status'>
                    {icon(Info)}
                    <span>{'The canvas closed.'}</span>
                    <button type='button' className='oc-btn pri' onClick={retry}>{'Reopen'}</button>
                </div>
            )}
        </>
    );
}

// ---------------------------------------------------------------- S4 list

function ChannelList() {
    const channelId = useCurrentChannel();
    const version = useCell(listVersion);
    const now = useCell(clock);
    const [st, setSt] = React.useState<{s: 'loading'} | {s: 'ok'; rows: CanvasRecord[]} | {s: 'error'} | {s: 'no-access'}>({s: 'loading'});
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(startClock, []);
    React.useEffect(() => {
        let live = true;
        if (!channelId) {
            return undefined;
        }
        listChannelCanvases(channelId).then((r) => {
            if (!live) {
                return;
            }
            if (r.ok) {
                setSt({s: 'ok', rows: r.data});
            } else {
                setSt(r.status === 403 ? {s: 'no-access'} : {s: 'error'});
            }
        });
        return () => {
            live = false;
        };
    }, [channelId, version, attempt]);
    React.useEffect(() => setSt({s: 'loading'}), [channelId]);

    const create = () => dialog.set({kind: 'create', channelId: channelId || currentChannelId()});
    if (st.s === 'no-access') {
        return <State tile={icon(Lock, 20)} title="You don't have access to this channel's canvases" text='Ask someone in the channel to add you.'/>;
    }
    if (st.s === 'ok' && st.rows.length === 0) {
        return (
            <State tile={icon(FileText, 20)} title='No canvases in this channel yet' text='Plan a release, take meeting notes or track work together, right in the channel.'>
                <button type='button' className='oc-btn pri' onClick={create}>{icon(Plus, 14)}{'Create canvas'}</button>
            </State>
        );
    }
    if (st.s === 'error') {
        return (
            <State tile={icon(CloudOff, 20)} title="Couldn't load canvases" text="Your Mattermost server didn't answer in time.">
                <button type='button' className='oc-btn pri' onClick={() => setAttempt(attempt + 1)}>{icon(RotateCcw, 14)}{'Retry'}</button>
            </State>
        );
    }
    return (
        <>
            <div className='oc-lhead'>
                <span>{'Newest first'}</span>
                <button type='button' className='oc-btn pri' onClick={create}>{icon(Plus, 14)}{'Create canvas'}</button>
            </div>
            <div className='oc-rows' role='list' aria-busy={st.s === 'loading'}>
                {st.s === 'loading' ? [0, 1, 2, 3].map((i) => (
                    <div key={i} className='oc-row sk' aria-hidden='true'>
                        <span className='oc-sk' style={{width: 36, height: 36, borderRadius: 8}}/>
                        <span className='oc-rt'>
                            <span className='oc-sk' style={{display: 'block', width: `${60 - (i * 9)}%`, height: 12, marginBottom: 8}}/>
                            <span className='oc-sk' style={{display: 'block', width: '38%', height: 9}}/>
                        </span>
                    </div>
                )) : st.rows.map((r) => (
                    <button key={r.id} type='button' role='listitem' className='oc-row' onClick={() => showCanvas(r.id)}>
                        <span className='oc-tile md'><KindIcon template={r.template} size={18}/></span>
                        <span className='oc-rt'>
                            <span className='oc-r1' style={{display: 'block'}}>{r.title}</span>
                            <span className='oc-r2' style={{display: 'block'}}>{cardMeta(r, now)}</span>
                        </span>
                    </button>
                ))}
            </div>
        </>
    );
}
