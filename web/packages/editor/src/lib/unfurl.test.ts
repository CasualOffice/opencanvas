// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

import { afterEach, describe, expect, it, vi } from "vitest";
import { setAssetTicket } from "./assets";
import { cardImageSrc, fetchPreview, markPending, previewAttrs, setUnfurl, unfurlFor } from "./unfurl";

const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("link-card unfurl (UNF-01)", () => {
  afterEach(() => {
    setAssetTicket(null);
    setUnfurl(false);
  });

  it("asks the server with this viewer's ticket and keeps only safe fields", async () => {
    setAssetTicket("T 1");
    const f = ok({ title: "Plan", description: "D", siteName: "Acme", image: "javascript:alert(1)", extra: "x" });
    const p = await fetchPreview("https://acme.example/a?b=1", f);
    expect(p).toEqual({ title: "Plan", description: "D", siteName: "Acme", image: "" });
    const called = (f as unknown as { mock: { calls: [string][] } }).mock.calls[0][0];
    expect(called).toBe("/v1/unfurl?ticket=T+1&url=https%3A%2F%2Facme.example%2Fa%3Fb%3D1");
  });

  it("falls back (null) on errors, so the card keeps the hostname", async () => {
    setAssetTicket("T");
    const fail = vi.fn(async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    expect(await fetchPreview("https://a.example", fail)).toBeNull();
    const boom = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchPreview("https://a.example", boom)).toBeNull();
    expect(previewAttrs("https://www.a.example/x", { title: "", description: "", siteName: "", image: "" })).toEqual({
      title: "a.example",
      description: "",
      site: "a.example",
      image: "",
    });
  });

  it("unfurls only cards a person inserted, once, and only when the session allows it", async () => {
    setAssetTicket("T");
    const f = ok({ title: "Once" });
    markPending("https://b.example");
    expect(unfurlFor("https://b.example", f)).toBeNull(); // unfurl off for this session
    setUnfurl(true);
    expect(unfurlFor("https://c.example", f)).toBeNull(); // not inserted here (e.g. by the assistant)
    const p = unfurlFor("https://b.example", f);
    expect(p).not.toBeNull();
    expect(unfurlFor("https://b.example", f)).toBe(p); // a re-mount joins the same request
    expect((await p)?.title).toBe("Once");
    await new Promise((r) => setTimeout(r, 0));
    expect(unfurlFor("https://b.example", f)).toBeNull(); // done: never again
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it("loads card images through the same-origin proxy only", () => {
    setAssetTicket("T");
    expect(cardImageSrc("https://cdn.example/x.png")).toBeUndefined(); // off
    setUnfurl(true);
    expect(cardImageSrc("https://cdn.example/x.png")).toBe("/v1/unfurl/image?ticket=T&url=https%3A%2F%2Fcdn.example%2Fx.png");
    expect(cardImageSrc("data:image/svg+xml,<svg/>")).toBeUndefined();
    expect(cardImageSrc("")).toBeUndefined();
  });
});
