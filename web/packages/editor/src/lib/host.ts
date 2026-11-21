// postMessage API between the canvas iframe and the host page (docs/05 §4),
// using the WOPI-style envelope { MessageId, SendTime, Values }.
//
// The server sends `Referrer-Policy: no-referrer` and restricts who may frame
// us with `frame-ancestors` (docs/15 §6), so the parent is always an allowed
// host. We learn its origin from ancestorOrigins / referrer when available,
// otherwise from the first message the parent sends (Host_PostmessageReady).
// Until then only the content-free Frame_Ready announcement is sent.

type Handler = (values: Record<string, unknown>) => void;

const embedded = window.parent !== window;

function guessOrigin(): string | null {
  try {
    return window.parent.location.origin; // same-origin parent
  } catch {
    /* cross-origin */
  }
  const ao = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  if (ao && ao.length) return ao[0];
  if (document.referrer) {
    try {
      return new URL(document.referrer).origin;
    } catch {
      /* ignore */
    }
  }
  return null;
}

let origin: string | null = embedded ? guessOrigin() : null;
const handlers = new Map<string, Set<Handler>>();
const queue: [string, Record<string, unknown>][] = [];

export function postToHost(MessageId: string, Values: Record<string, unknown> = {}) {
  if (!embedded) return;
  const msg = { MessageId, SendTime: Date.now(), Values };
  if (origin) window.parent.postMessage(msg, origin);
  else if (MessageId === "App_LoadingStatus" && Values.Status === "Frame_Ready") window.parent.postMessage(msg, "*");
  else if (queue.length < 50) queue.push([MessageId, Values]);
}

export function onHost(id: string, fn: Handler): () => void {
  let s = handlers.get(id);
  if (!s) handlers.set(id, (s = new Set()));
  s.add(fn);
  return () => void s!.delete(fn);
}

if (embedded) {
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    if (!origin) {
      origin = e.origin;
      queue.splice(0).forEach(([id, v]) => postToHost(id, v));
    }
    if (e.origin !== origin) return;
    const d = typeof e.data === "string" ? safeJson(e.data) : e.data;
    if (!d || typeof d.MessageId !== "string") return;
    handlers.get(d.MessageId)?.forEach((f) => f((d.Values ?? {}) as Record<string, unknown>));
  });
}

function safeJson(s: string): { MessageId?: string; Values?: unknown } | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export const isEmbedded = embedded;
