// How the assistant UI talks to a run. The server transport sends the docs/15 §3.1 control
// messages over the collaboration socket; the `#demo` transport (demo.ts) plays a scripted run
// on the local doc. The UI is the same for both: only this object differs. No keys, no model
// calls here: the server holds the provider (docs/24 §8.2).
import type { Collab } from "../lib/session";
import { isAiMsg, type AiMsg, type Mode, type Selection } from "./model";

export interface RunRequest {
  runId: string;
  prompt: string;
  mode: Mode;
  selection: Selection;
}

export interface Transport {
  /** "Demo: a scripted run, no AI server" when set. */
  readonly demo: boolean;
  run(r: RunRequest): void;
  approve(runId: string): void;
  cancel(runId: string): void;
  undo(runId: string): void;
  on(fn: (m: AiMsg) => void): () => void;
}

export function serverTransport(collab: Collab): Transport {
  return {
    demo: false,
    // `confirm: true`: the run waits after its plan until `ai-approve` (nothing changes before Run).
    run: (r) =>
      collab.sendControl({
        t: "ai-run",
        runId: r.runId,
        prompt: r.prompt,
        mode: r.mode,
        // docs/15 §3.1: in mode `edit` the run waits after `ai-plan` until `ai-approve`.
        ...(r.mode === "edit" ? { confirm: true } : {}),
        // A string (the server wraps it as data, never as instructions).
        ...(r.selection.kind === "none" ? {} : { selection: r.selection.lines.join("\n") }),
      }),
    approve: (runId) => collab.sendControl({ t: "ai-approve", runId }),
    cancel: (runId) => collab.sendControl({ t: "ai-cancel", runId }),
    undo: (runId) => collab.sendControl({ t: "ai-undo", runId }),
    on: (fn) => collab.onControl((c) => isAiMsg(c) && fn(c)),
  };
}
