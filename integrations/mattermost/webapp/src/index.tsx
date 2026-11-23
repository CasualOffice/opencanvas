// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Scaffold only. Every component renders a plain placeholder: the real screens wait for the
// owner's prototype approval (ADR-011); see ../UI-SCREENS.md for what each one must do.
// Mattermost provides React on window.React (externals in the build).

import * as React from 'react';
import {SquarePen} from 'lucide-react';

import {CanvasPost} from './components/CanvasPost';
import {CanvasPanel, setPanelCanvas} from './components/CanvasPanel';
import {createCanvas} from './api';

const PLUGIN_ID = 'com.casualoffice.opencanvas';

// The subset of Mattermost's PluginRegistry this plugin uses
// (webapp/channels/src/plugins/registry.ts).
interface Registry {
    registerRightHandSidebarComponent(component: React.ComponentType, title: React.ReactNode):
        {id: string; showRHSPlugin: unknown; hideRHSPlugin: unknown; toggleRHSPlugin: unknown};
    registerPostTypeComponent(type: string, component: React.ComponentType<{post: Post}>): string;
    registerChannelHeaderButtonAction(icon: React.ReactNode, action: (channel: {id: string}) => void,
        dropdownText: string, tooltipText: string): string;
}

export interface Post {
    id: string;
    channel_id: string;
    props: Record<string, unknown>;
}

interface Store {dispatch(action: unknown): void}

class Plugin {
    initialize(registry: Registry, store: Store) {
        const rhs = registry.registerRightHandSidebarComponent(CanvasPanel, 'Canvas');
        const open = (fileId: string) => {
            setPanelCanvas(fileId);
            store.dispatch(rhs.showRHSPlugin);
        };
        registry.registerPostTypeComponent('custom_opencanvas', (props: {post: Post}) => (
            <CanvasPost post={props.post} onOpen={open}/>
        ));
        registry.registerChannelHeaderButtonAction(
            <SquarePen size={16} aria-hidden='true'/>,
            async (channel) => {
                // Placeholder flow: creates an untitled canvas at once. The create dialog
                // (UI-SCREENS.md S3) replaces this after approval.
                const rec = await createCanvas(channel.id, '', '');
                if (rec) {
                    open(rec.id);
                }
            },
            'Create canvas',
            'Create a canvas in this channel',
        );
    }
}

declare global {
    interface Window {
        registerPlugin(id: string, plugin: Plugin): void;
    }
}

window.registerPlugin(PLUGIN_ID, new Plugin());
