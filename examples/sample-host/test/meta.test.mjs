// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// RLB-04: the Playwright helpers read the sample host's meta.json from another process
// (e2e/helpers.ts hostFiles) while the host saves it. A save that truncates the file and then
// writes it let a reader see an empty or half-written file ("Unexpected end of JSON input",
// zg-live-gaps on main at f7a711f). Every read must parse while the host saves.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const here = path.dirname(fileURLToPath(import.meta.url));

async function startHost(server, env) {
  const child = spawn(process.execPath, [server], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    child.once("exit", (c) => reject(new Error(`host exited ${c}`)));
    child.stdout.on("data", (d) => String(d).includes(" on ") && resolve());
  });
  return child;
}

test("meta.json always parses while the sample host saves it", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "oc-meta-"));
  // A metadata file the size of a long e2e run (a few thousand files), so a save takes time.
  const files = {};
  for (let i = 0; i < 4000; i++) files[`doc_${i}`] = { id: `doc_${i}`, name: `File ${i}`, version: i, updatedAt: null, acl: { u_priya: "edit" } };
  fs.writeFileSync(path.join(data, "meta.json"), JSON.stringify({ files }));
  const port = 4900 + Math.floor(Math.random() * 90);
  const host = await startHost(path.join(here, "..", "server.mjs"), {
    PORT: String(port), DATA_DIR: data, SAMPLE_HOST_TEST: "1", OC_SERVER_INTERNAL: "http://127.0.0.1:9",
  });
  try {
    // The reader is another thread, as Playwright is another process: it reads in a loop
    // while this thread asks the host to save.
    const stop = new Int32Array(new SharedArrayBuffer(4));
    const reader = new Worker(
      `const { workerData: { file, stop }, parentPort } = require("node:worker_threads");
       const fs = require("node:fs");
       let reads = 0; const torn = [];
       while (Atomics.load(stop, 0) === 0) {
         const text = fs.readFileSync(file, "utf8");
         // A whole file ends with its closing brace (parsed in full once at the end).
         if (!text.trimEnd().endsWith("}")) torn.push(text.length + " bytes");
         reads++;
       }
       parentPort.postMessage({ reads, torn });`,
      { eval: true, workerData: { file: path.join(data, "meta.json"), stop } },
    );
    const result = new Promise((r) => reader.once("message", r));
    for (let i = 0; i < 200; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/__test/files/doc_1/members`, { method: "POST", body: JSON.stringify({ source: i % 2 ? "token" : "both" }) });
      assert.equal(r.status, 200);
    }
    Atomics.store(stop, 0, 1);
    const { reads, torn } = await result;
    assert.ok(reads > 50, `read ${reads} times`);
    assert.deepEqual(torn.slice(0, 3), [], `${torn.length} of ${reads} reads saw a torn file`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, "meta.json"), "utf8")).files.doc_1.memberSource, "token");
  } finally {
    host.kill();
    fs.rmSync(data, { recursive: true, force: true });
  }
});
