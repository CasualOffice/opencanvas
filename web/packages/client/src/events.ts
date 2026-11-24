// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The events stream (docs/05 §7b) over Server-Sent Events on fetch, so it can carry the
// client's credentials (EventSource cannot set headers). Reconnects resume with
// Last-Event-ID: the server answers what was missed, or a `resync` event when it no longer
// has it.

import type { Event as OcEvent } from "./generated.js";
import { StreamClosedError } from "./errors.js";

export interface EventsOptions {
  fileId: string;
  /** Only these event types (default: all). */
  types?: string[];
  /** Resume after this event id (the `id` of the last event you handled). */
  lastEventId?: string;
  /** Reconnect (resuming) when the stream drops; default true. */
  reconnect?: boolean;
  /** Give up after this many reconnects in a row without an event; default 10. */
  maxReconnects?: number;
  signal?: AbortSignal;
}

/** Opens one HTTP stream (the client adds credentials and checks the status). */
export type OpenStream = (lastEventId: string | undefined, signal: AbortSignal) => Promise<Response>;

interface Frame {
  id?: string;
  event: string;
  data: string;
}

/** Parses SSE frames out of a growing buffer; returns the frames and the unparsed rest. */
export function parseFrames(buffer: string): { frames: Frame[]; rest: string } {
  const text = buffer.replace(/\r\n?/g, "\n");
  const frames: Frame[] = [];
  let start = 0;
  for (;;) {
    const end = text.indexOf("\n\n", start);
    if (end < 0) break;
    const block = text.slice(start, end);
    start = end + 2;
    const f: Frame = { event: "message", data: "" };
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? "" : line.slice(i + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "id") f.id = value;
      else if (field === "event") f.event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length === 0) continue;
    f.data = data.join("\n");
    frames.push(f);
  }
  return { frames, rest: text.slice(start) };
}

/**
 * Change events of one file, as an async iterator. `for await (const e of stream)`; `break`
 * (or `close()`) ends it. `lastEventId` is the id to resume from later.
 */
export class EventStream implements AsyncIterableIterator<OcEvent> {
  lastEventId?: string;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private abort = new AbortController();
  private buffer = "";
  private queue: OcEvent[] = [];
  private closed = false;
  private failures = 0;
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly open: OpenStream,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly opts: EventsOptions,
  ) {
    this.lastEventId = opts.lastEventId;
    opts.signal?.addEventListener("abort", () => this.close(), { once: true });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  /** Connects now (otherwise the first `next()` does); resolves once the server accepted the
   * stream, so events of changes made after this are delivered. */
  async ready(): Promise<void> {
    if (!this.reader && !this.closed) await this.connect();
  }

  /** Ends the stream; a pending `next()` resolves as done. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.reader?.cancel().catch(() => {});
  }

  async return(): Promise<IteratorResult<OcEvent>> {
    this.close();
    return { done: true, value: undefined };
  }

  async next(): Promise<IteratorResult<OcEvent>> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued) return { done: false, value: queued };
      if (this.closed) return { done: true, value: undefined };
      if (!this.reader) {
        await this.connect();
        continue;
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await this.reader.read();
      } catch (e) {
        if (this.closed) return { done: true, value: undefined };
        await this.dropped(e);
        continue;
      }
      if (chunk.done) {
        await this.dropped(undefined);
        continue;
      }
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
      const { frames, rest } = parseFrames(this.buffer);
      this.buffer = rest;
      for (const f of frames) this.take(f);
    }
  }

  private take(f: Frame): void {
    let data: unknown;
    try {
      data = JSON.parse(f.data);
    } catch {
      return;
    }
    if (f.event === "close") {
      const { code = 0, reason = "" } = (data ?? {}) as { code?: number; reason?: string };
      // 4008: we fell behind; reconnecting resumes from the last id. Anything else is final.
      if (code === 4008) {
        this.reader?.cancel().catch(() => {});
        this.reader = undefined;
        return;
      }
      this.close();
      throw new StreamClosedError(code, reason);
    }
    const ev = data as OcEvent;
    if (f.id) this.lastEventId = f.id;
    else if (typeof ev?.id === "string") this.lastEventId = ev.id;
    this.failures = 0;
    this.queue.push(ev);
  }

  private async connect(): Promise<void> {
    const res = await this.open(this.lastEventId, this.abort.signal);
    if (!res.body) throw new StreamClosedError(0, "the answer has no body");
    this.buffer = "";
    this.reader = res.body.getReader();
  }

  private async dropped(cause: unknown): Promise<void> {
    this.reader = undefined;
    if (this.closed) return;
    const max = this.opts.maxReconnects ?? 10;
    if (this.opts.reconnect === false || this.failures >= max) {
      this.close();
      if (cause) throw cause;
      return;
    }
    await this.sleep(Math.min(30_000, 1000 * 2 ** this.failures));
    this.failures += 1;
  }
}
