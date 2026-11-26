// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The device key and the offline grant (ADR-063). The device key is a non-extractable AES-GCM
// key, one per host and person, in its own database: deleting it makes every copy unreadable at
// once (crypto-shredding), even if the browser keeps the files for a while. It does not protect
// against someone who controls the browser profile; the OS lock does.
import type { Kv } from "./kv";
import { keyDb } from "./names";

export interface Sealed {
  iv: Uint8Array;
  ct: ArrayBuffer;
}

const subtle = () => globalThis.crypto.subtle;

/** The person's device key; created on first use when `create`. */
export async function deviceKey(kv: Kv, host: string, user: string, create: boolean): Promise<CryptoKey | null> {
  const db = keyDb(host, user);
  const have = await kv.get<CryptoKey>(db, "k", "device");
  if (have || !create) return have ?? null;
  const k = await subtle().generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await kv.put(db, "k", k, "device");
  return k;
}

export async function seal(key: CryptoKey, data: Uint8Array): Promise<Sealed> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  return { iv, ct: await subtle().encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, data as BufferSource) };
}

export async function open(key: CryptoKey, s: Sealed): Promise<Uint8Array> {
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: s.iv as BufferSource }, key, s.ct));
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const sealJson = (key: CryptoKey, v: unknown) => seal(key, enc.encode(JSON.stringify(v)));
export const openJson = async <T>(key: CryptoKey, s: Sealed): Promise<T> => JSON.parse(dec.decode(await open(key, s))) as T;

// ---------- the offline grant (ES256 JWS, docs/15 §6) ----------

export interface GrantClaims {
  iss: string;
  host: string;
  sub: string;
  file: string;
  role: "view" | "comment" | "edit";
  iat: number;
  exp: number;
  gen: number;
  perms?: { download?: boolean; comment?: boolean };
}

const b64u = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

/** The grant's claims when its signature checks against `jwk`, else null. */
export async function verifyGrant(jws: string, jwk: JsonWebKey): Promise<GrantClaims | null> {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  try {
    const head = JSON.parse(dec.decode(b64u(parts[0])));
    if (head.alg !== "ES256" || head.typ !== "oc-offline+jwt") return null;
    const key = await subtle().importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await subtle().verify({ name: "ECDSA", hash: "SHA-256" }, key, b64u(parts[2]) as BufferSource, enc.encode(parts[0] + "." + parts[1]) as BufferSource);
    return ok ? (JSON.parse(dec.decode(b64u(parts[1]))) as GrantClaims) : null;
  } catch {
    return null;
  }
}
