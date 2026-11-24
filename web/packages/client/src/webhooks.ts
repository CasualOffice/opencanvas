// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Verifies `X-OpenCanvas-Signature: t=<ts>,v1=<hex>,v2=<hex>` on webhook deliveries
// (docs/05 §7c): v2 = HMAC-SHA256(secret, "<ts>.<METHOD>.<path?query>.<body>"), compared in
// constant time, and the timestamp within 5 minutes of now. Web Crypto only (Node 20+,
// browsers, Deno, edge runtimes).

export interface VerifyWebhookInput {
  /** The webhook secret: `[host.webhooks] secret`, else your host's callback secret. */
  secret: string;
  /** The `X-OpenCanvas-Signature` header. */
  signature: string;
  /** The raw request body, exactly as received (before any JSON parsing). */
  body: string | Uint8Array;
  /** The request path and query as your server received it, e.g. `/hooks/opencanvas?x=1`. */
  pathQuery: string;
  /** Default `POST`. */
  method?: string;
  /** Unix seconds; default now. */
  nowSecs?: number;
  /** Default 300. */
  toleranceSecs?: number;
}

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Whether a webhook delivery is authentic and recent. Never throws for bad input. */
export async function verifyWebhook(input: VerifyWebhookInput): Promise<boolean> {
  const parts = new Map<string, string>();
  for (const p of input.signature.split(",")) {
    const i = p.indexOf("=");
    if (i > 0 && !parts.has(p.slice(0, i).trim())) parts.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
  const t = Number(parts.get("t"));
  const v2 = parts.get("v2");
  if (!parts.has("t") || !Number.isInteger(t) || !v2) return false;
  const now = input.nowSecs ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (input.toleranceSecs ?? 300)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = enc.encode(`${t}.${(input.method ?? "POST").toUpperCase()}.${input.pathQuery}.`);
  const body = typeof input.body === "string" ? enc.encode(input.body) : input.body;
  const msg = new Uint8Array(prefix.length + body.length);
  msg.set(prefix, 0);
  msg.set(body, prefix.length);
  const mac = hex(await crypto.subtle.sign("HMAC", key, msg));
  return sameText(mac, v2.toLowerCase());
}
