// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Placeholder for the post card (UI-SCREENS.md S1). Unstyled on purpose (ADR-011).

import * as React from 'react';

import type {Post} from '../index';

export function CanvasPost({post, onOpen}: {post: Post; onOpen: (fileId: string) => void}) {
    const fileId = String(post.props.opencanvas_file_id ?? '');
    const title = String(post.props.opencanvas_title ?? 'Canvas');
    return (
        <div>
            <div>{title}</div>
            <button type='button' onClick={() => onOpen(fileId)}>Open</button>
        </div>
    );
}
