// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Copy a link; when the clipboard is refused (the Desktop app without a trusted origin, S7a),
// show the link selected with how to finish by hand.

import * as React from 'react';
import {ClipboardX, X} from 'lucide-react';

import {isDesktopApp} from '../logic';
import {dialog, useCell} from '../store';

export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        dialog.set({kind: 'copy', url: text});
        return false;
    }
}

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** S7a "Link to this canvas": anchored under the panel header when the panel is open. */
export function CopyFallback({inPanel}: {inPanel: boolean}) {
    const d = useCell(dialog);
    const input = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => {
        input.current?.focus();
        input.current?.select();
    }, [d]);
    if (d?.kind !== 'copy') {
        return null;
    }
    const keys = isMac() ? '⌘C' : 'Ctrl+C';
    const where = isDesktopApp(navigator.userAgent) ? "Copy isn't allowed in the Desktop app." : "Copy isn't allowed here.";
    return (
        <div
            className={'oc oc-pop' + (inPanel ? '' : ' fixed')}
            role='dialog'
            aria-label='Link to this canvas'
            onKeyDown={(e) => e.key === 'Escape' && dialog.set(null)}
        >
            <h3>{'Link to this canvas'}</h3>
            <button type='button' className='oc-ib sm oc-x' aria-label='Close' onClick={() => dialog.set(null)}><X size={16} strokeWidth={1.75} aria-hidden='true'/></button>
            <input
                ref={input}
                readOnly={true}
                value={d.url}
                aria-label='Link'
                onFocus={(e) => e.currentTarget.select()}
                onCopy={() => window.setTimeout(() => dialog.set(null), 600)}
            />
            <div className='oc-warn'>
                <ClipboardX size={14} strokeWidth={1.75} aria-hidden='true'/>
                <span>{`${where} The link is selected: press ${keys}, or open the canvas in your browser.`}</span>
            </div>
        </div>
    );
}
