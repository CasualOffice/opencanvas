// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// GRAPH-02: the force layout off the main thread. Posts positions about 60 times a second while
// it moves and once more when it settles; with `still` (reduced motion) it posts only the result.
import { run, type Cmd } from "./runner-core";

const post = (m: unknown, t?: Transferable[]) => (self as unknown as Worker).postMessage(m, t ?? []);
const handle = run((x, y, done, gen) => post({ gen, x, y, done }, [x.buffer, y.buffer]));
self.onmessage = (e: MessageEvent<Cmd>) => handle(e.data);
