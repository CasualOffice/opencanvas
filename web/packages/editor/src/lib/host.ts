// postMessage API between the canvas iframe and the host page (docs/05 §4),
// using the Collabora-compatible envelope { MessageId, SendTime, Values }.

type Handler = (values: Record<string, unknown>) => void;

const embedded = window.parent !== window;

/** The host page's origin. We only talk to the page that embedded us. */
function hostOrigin(): string | null {
  try {
    // Same-origin parents (dev, sample host behind the same proxy).
    return window.parent.location.origin;
  } catch {
    /* cross-origin */
  }
  if (document.referrer) {
    try {
      return new URL(document.referrer).origin;
    } catch {
      /* ignore */
    }
  }
  // Chrome exposes the embedding origin chain.
  const ao = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  return ao && ao.length ? ao[0] : null;
}

const origin = embedded ? hostOrigin() : null;
const handlers = new Map<string, Set<Handler>>();

export function postToHost(MessageId: string, Values: Record<string, unknown> = {}) {
  if (!embedded || !origin) return;
  window.parent.postMessage({ MessageId, SendTime: Date.now(), Values }, origin);
}

export function onHost(id: string, fn: Handler): () => void {
  let s = handlers.get(id);
  if (!s) handlers.set(id, (s = new Set()));
  s.add(fn);
  return () => void s!.delete(fn);
}

if (embedded) {
  window.addEventListener("message", (e: MessageEvent) => {
    if (!origin || e.origin !== origin || e.source !== window.parent) return;
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
