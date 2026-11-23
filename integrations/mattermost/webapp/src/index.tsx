// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// OpenCanvas webapp plugin: the screens approved on 2026-11-24
// (docs/prototypes/mattermost-approved): S1 card, S2 panel, S3 create dialog, S4 channel
// canvases, S7 Desktop app. Mattermost provides React on window.React (see the build alias).

import * as React from 'react';
import {LayoutGrid, SquarePen} from 'lucide-react';

import {PLUGIN_ID} from './api';
import {isListCommand} from './logic';
import {CanvasPost} from './components/CanvasPost';
import {CanvasPanel, PanelTitle} from './components/CanvasPanel';
import {makeRoot} from './components/Dialogs';
import {dialog, onCanvasUpdated, panel, setMM, showCanvas, showList, type MMStore} from './store';
import {injectStyles} from './styles';

// The subset of Mattermost's PluginRegistry this plugin uses
// (webapp/channels/src/plugins/registry.ts).
interface Registry {
    registerRightHandSidebarComponent(component: React.ComponentType, title: React.ReactNode, showPopout?: boolean):
        {id: string; showRHSPlugin: unknown; hideRHSPlugin: unknown; toggleRHSPlugin: unknown};
    registerPostTypeComponent(type: string, component: React.ComponentType<{post: Post}>): string;
    registerChannelHeaderButtonAction(icon: React.ReactNode, action: (channel: {id: string}) => void,
        dropdownText: string, tooltipText: string): string;
    registerRootComponent(component: React.ComponentType): string;
    registerWebSocketEventHandler(event: string, handler: (msg: {data: Record<string, unknown>}) => void): void;
    registerSlashCommandWillBePostedHook(hook: (message: string, args: unknown) =>
        Promise<{message?: string; args?: unknown}> | {message?: string; args?: unknown}): string;
}

export interface Post {
    id: string;
    channel_id: string;
    props: Record<string, unknown>;
}

// Mattermost's own action for its expand button (webapp/channels/src/actions/views/rhs.ts).
const SET_RHS_EXPANDED = 'SET_RHS_EXPANDED';

const iconProps = {size: 18, strokeWidth: 1.75, 'aria-hidden': 'true' as const};

class Plugin {
    initialize(registry: Registry, store: MMStore) {
        setMM(store);
        injectStyles();
        const rhs = registry.registerRightHandSidebarComponent(
            () => <CanvasPanel host={{hide: () => store.dispatch(rhs.hideRHSPlugin)}}/>,
            <PanelTitle/>,
            false, // no Mattermost popout: the header has its own "Open in new window" (S2)
        );
        const open = (fileId: string) => {
            showCanvas(fileId);
            store.dispatch(rhs.showRHSPlugin);
        };
        const openExpanded = (fileId: string) => {
            open(fileId);
            store.dispatch({type: SET_RHS_EXPANDED, expanded: true});
        };
        const openList = () => {
            showList();
            store.dispatch(rhs.showRHSPlugin);
        };
        registry.registerPostTypeComponent('custom_opencanvas', (props: {post: Post}) => (
            <CanvasPost post={props.post} actions={{open, openExpanded}}/>
        ));
        // In Mattermost 9+ these two show in the App Bar on the right edge (S3a, S4).
        registry.registerChannelHeaderButtonAction(
            <SquarePen {...iconProps}/>,
            (channel) => dialog.set({kind: 'create', channelId: channel.id}),
            'Create canvas',
            'Create canvas',
        );
        registry.registerChannelHeaderButtonAction(
            <LayoutGrid {...iconProps}/>,
            () => openList(),
            'Channel canvases',
            'Channel canvases',
        );
        registry.registerRootComponent(makeRoot(open, () => panel.get().mounted));
        registry.registerWebSocketEventHandler(`custom_${PLUGIN_ID}_canvas_updated`, (msg) => onCanvasUpdated(msg.data));
        // `/canvas new` and `/canvas notes` create on the server; open the new canvas here (S2f).
        registry.registerWebSocketEventHandler(`custom_${PLUGIN_ID}_canvas_created`, (msg) => {
            if (typeof msg.data.fileId === 'string') {
                open(msg.data.fileId);
            }
        });
        // `/canvas list` opens the list panel here; the server answers it in text for the phone apps.
        registry.registerSlashCommandWillBePostedHook((message, args) => {
            if (isListCommand(message)) {
                openList();
                return {};
            }
            return {message, args};
        });
    }
}

declare global {
    interface Window {
        registerPlugin(id: string, plugin: Plugin): void;
    }
}

window.registerPlugin(PLUGIN_ID, new Plugin());
