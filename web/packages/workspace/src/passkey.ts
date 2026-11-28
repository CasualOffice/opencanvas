// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Passkeys in the browser (WS-06): the server sends options with base64url fields; WebAuthn
// wants ArrayBuffers, and the answers go back as base64url.

import { api } from "./api";

const toBuf = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const toB64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const passkeysSupported = () => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;

/** Adds a passkey to the signed-in account. */
export async function addPasskey(name: string): Promise<void> {
  const { publicKey: o } = await api.post<{ publicKey: Record<string, any> }>("/passkeys/register/options");
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...o,
      challenge: toBuf(o.challenge),
      user: { ...o.user, id: toBuf(o.user.id) },
      excludeCredentials: (o.excludeCredentials ?? []).map((c: { id: string }) => ({ type: "public-key" as const, id: toBuf(c.id) })),
    } as unknown as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was made.");
  const r = cred.response as AuthenticatorAttestationResponse;
  await api.post("/passkeys/register", {
    id: toB64(cred.rawId),
    name,
    response: { clientDataJSON: toB64(r.clientDataJSON), attestationObject: toB64(r.attestationObject) },
  });
}

/** Signs in with a passkey; `conditional` offers it in the e-mail field's autofill. */
export async function signInWithPasskey(conditional = false, signal?: AbortSignal): Promise<void> {
  const { publicKey: o } = await api.post<{ publicKey: Record<string, any> }>("/passkeys/login/options");
  const cred = (await navigator.credentials.get({
    publicKey: { ...o, challenge: toBuf(o.challenge), allowCredentials: [] } as unknown as PublicKeyCredentialRequestOptions,
    ...(conditional ? { mediation: "conditional" as CredentialMediationRequirement } : {}),
    signal,
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was chosen.");
  const r = cred.response as AuthenticatorAssertionResponse;
  await api.post("/passkeys/login", {
    id: toB64(cred.rawId),
    response: { clientDataJSON: toB64(r.clientDataJSON), authenticatorData: toB64(r.authenticatorData), signature: toB64(r.signature) },
  });
}

/** A short default name for this device's passkey. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "iPhone or iPad";
  if (/Mac/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  return "Passkey";
}
