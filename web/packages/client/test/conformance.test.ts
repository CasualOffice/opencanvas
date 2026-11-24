// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The shared conformance suite (crates/oc-server/api/conformance.json, grammar in docs/05
// §7d) against a real OpenCanvas server: the `conformance_server` example, built with cargo
// when OC_CONFORMANCE_BIN does not name a binary. The Rust client runs the same file
// (crates/oc-client/tests/conformance.rs). Set OC_CONFORMANCE=skip to run only the unit tests
// (the CI web job does; the clients job runs this).

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiError, OpenCanvas, verifyWebhook, type EventStream, type OperationId, type Params } from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SUITE = JSON.parse(readFileSync(join(ROOT, "crates/oc-server/api/conformance.json"), "utf8"));

type Json = any;

interface Info {
  baseUrl: string;
  hosts: Record<string, { id: string; key: string }>;
  webhookSecret: string;
}

function serverBinary(): string {
  if (process.env.OC_CONFORMANCE_BIN) return process.env.OC_CONFORMANCE_BIN;
  const target = process.env.CARGO_TARGET_DIR ?? join(ROOT, "target");
  const bin = join(target, "debug/examples/conformance_server");
  const built = spawnSync("cargo", ["build", "-q", "-p", "oc-server", "--example", "conformance_server"], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (built.status !== 0 || !existsSync(bin)) {
    throw new Error("could not build the conformance server (cargo); set OC_CONFORMANCE_BIN or OC_CONFORMANCE=skip");
  }
  return bin;
}

// ---------- the step interpreter (the Rust client has the same one) ----------

/** Replaces "{name}" (whole string: the saved JSON value) and "…{name}…" (text) by variables. */
export function subst(v: Json, vars: Record<string, Json>): Json {
  if (typeof v === "string") {
    const whole = /^\{([A-Za-z0-9_]+)\}$/.exec(v);
    if (whole && whole[1] in vars) return vars[whole[1]];
    return v.replace(/\{([A-Za-z0-9_]+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m));
  }
  if (Array.isArray(v)) return v.map((x) => subst(x, vars));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, vars)]));
  return v;
}

function pointer(v: Json, p: string): Json {
  if (p === "") return v;
  let cur = v;
  for (const raw of p.split("/").slice(1)) {
    const k = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) ? cur[Number(k)] : cur[k];
  }
  return cur;
}

function check(body: Json, matchers: Record<string, Json> | undefined, where: string) {
  for (const [p, m] of Object.entries(matchers ?? {})) {
    const got = pointer(body, p);
    const at = `${where} ${p} in ${JSON.stringify(body).slice(0, 400)}`;
    if (m && typeof m === "object" && !Array.isArray(m)) {
      if ("length" in m) expect(got?.length, at).toBe(m.length);
      if ("contains" in m) expect(String(got), at).toContain(m.contains);
      if ("exists" in m) expect(got !== undefined && got !== null, at).toBe(m.exists);
      if ("notEquals" in m) expect(got, at).not.toEqual(m.notEquals);
    } else {
      expect(got, at).toEqual(m);
    }
  }
}

function save(body: Json, spec: Record<string, string> | undefined, vars: Record<string, Json>) {
  for (const [name, p] of Object.entries(spec ?? {})) {
    const v = pointer(body, p);
    expect(v, `save ${name} from ${p}`).not.toBeUndefined();
    vars[name] = v;
  }
}

async function control(info: Info, path: string, body: Json): Promise<Json> {
  const res = await fetch(`${info.baseUrl}/__conformance/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.ok).toBe(true);
  return res.json();
}

function within<T>(p: Promise<T>, what: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: nothing within ${ms} ms`)), ms);
    }),
  ]);
}

async function runScenario(info: Info, sc: Json) {
  const host = info.hosts[sc.host];
  const slug = sc.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const vars: Record<string, Json> = { file: `ts-${slug}-${crypto.randomUUID().slice(0, 8)}` };
  const streams = new Map<string, EventStream>();
  let slept: number[] = [];
  const clientFor = async (auth: Json): Promise<OpenCanvas> => {
    const sleep = async (ms: number) => {
      slept.push(ms);
      await control(info, "clock", { advanceMs: ms });
    };
    if (auth?.token) {
      const { token } = await control(info, "token", { host: host.id, ...auth.token });
      return new OpenCanvas({ baseUrl: info.baseUrl, auth: { token }, sleep });
    }
    const key = auth?.hostKey ?? host.key;
    return new OpenCanvas({ baseUrl: info.baseUrl, auth: { hostId: host.id, key }, sleep });
  };
  try {
    for (const [i, raw] of sc.steps.entries()) {
      const step = subst(raw, vars);
      const where = `${sc.name} step ${i + 1}`;
      slept = [];
      if (step.call) {
        const client = await clientFor(step.auth);
        const expectErr = step.expect?.error;
        try {
          const res = await client.call(step.call as OperationId, step.params as Params<OperationId>, step.options);
          expect(expectErr, `${where}: expected an error, got ${JSON.stringify(res.data)}`).toBeUndefined();
          if (step.expect?.etag !== undefined) expect(res.etag, where).toBe(step.expect.etag);
          if (step.expect?.replayed !== undefined) expect(res.replayed, where).toBe(step.expect.replayed);
          if (step.expect?.sleptMs !== undefined) expect(slept, where).toEqual(step.expect.sleptMs);
          check(res.data, step.expect?.body, where);
          save(res.data, step.save, vars);
        } catch (e) {
          if (!(e instanceof ApiError) || !expectErr) throw e;
          expect(e.status, where).toBe(expectErr.status);
          expect(e.code, where).toBe(expectErr.code);
          expect(e.kind, where).toBe(expectErr.kind);
          if (expectErr.retryAfterSecs !== undefined) expect(e.retryAfterSecs, where).toBe(expectErr.retryAfterSecs);
          check(e.problem, step.expect?.body, where);
          save(e.problem, step.save, vars);
        }
      } else if (step.paginate) {
        const client = await clientFor(step.auth);
        let pages = 0;
        const items: Json[] = [];
        for await (const page of client.pages(step.paginate, step.params)) {
          pages += 1;
          items.push(...(page as Json)[step.paginate === "listBlocks" ? "blocks" : "rows"]);
        }
        const viaItems: Json[] = [];
        for await (const item of client.paginate(step.paginate, step.params)) viaItems.push(item);
        expect(viaItems, where).toEqual(items);
        if (step.expect?.count !== undefined) expect(items.length, where).toBe(step.expect.count);
        if (step.expect?.pages !== undefined) expect(pages, where).toBe(step.expect.pages);
        if (step.expect?.uniqueBy) {
          const keys = items.map((x) => pointer(x, step.expect.uniqueBy));
          expect(new Set(keys).size, where).toBe(keys.length);
        }
        save(items, step.save, vars);
      } else if (step.events === "open") {
        const client = await clientFor(step.auth);
        const s = client.events({ ...step.params, reconnect: false });
        streams.set(step.stream, s);
        // Wait for the answer headers, so the subscription exists before the next step writes.
        await within(s.ready(), `${where} open`);
      } else if (step.events === "next") {
        const s = streams.get(step.stream)!;
        const r = await within(s.next(), where);
        expect(r.done, where).toBe(false);
        check(r.value, step.expect?.body, where);
        save(r.value, step.save, vars);
        expect(s.lastEventId, where).toBe((r.value as Json).id);
      } else if (step.events === "close") {
        streams.get(step.stream)!.close();
        streams.delete(step.stream);
      } else if (step.webhook) {
        const got = await control(info, "webhooks", { type: step.webhook, fileId: vars.file });
        expect(got.deliveries.length, `${where}: a ${step.webhook} delivery`).toBeGreaterThan(0);
        for (const d of got.deliveries) {
          const input = { secret: info.webhookSecret, signature: d.signature, body: d.body, pathQuery: d.pathQuery, nowSecs: got.nowSecs };
          expect(await verifyWebhook(input), where).toBe(step.expect?.verified ?? true);
          expect(await verifyWebhook({ ...input, body: d.body.replace(vars.file, "another-file") }), where).toBe(false);
          check(JSON.parse(d.body), step.expect?.body, where);
        }
      } else if (step.clock !== undefined) {
        await control(info, "clock", { advanceMs: step.clock });
      } else {
        throw new Error(`${where}: unknown step ${JSON.stringify(step)}`);
      }
    }
  } finally {
    for (const s of streams.values()) s.close();
  }
}

describe("webhook vectors", () => {
  for (const v of SUITE.webhookVectors) {
    it(v.name, async () => {
      const ok = await verifyWebhook({
        secret: v.secret,
        signature: v.signature,
        method: v.method,
        pathQuery: v.pathQuery,
        body: v.body,
        nowSecs: v.nowSecs,
      });
      expect(ok).toBe(v.valid);
    });
  }
});

describe.skipIf(process.env.OC_CONFORMANCE === "skip")("conformance against a real server", () => {
  let proc: ChildProcessByStdio<Writable, Readable, null>;
  let info: Info;

  beforeAll(async () => {
    proc = spawn(serverBinary(), [], { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"] });
    const lines = createInterface({ input: proc.stdout });
    info = await within(
      new Promise<Info>((resolve, reject) => {
        lines.once("line", (l) => resolve(JSON.parse(l)));
        proc.once("exit", (c) => reject(new Error(`conformance server exited (${c})`)));
      }),
      "conformance server start",
      60_000,
    );
  }, 600_000);

  afterAll(() => {
    proc?.stdin.end();
    proc?.kill();
  });

  for (const sc of SUITE.scenarios) {
    it(sc.name, () => runScenario(info, sc), 60_000);
  }
});
