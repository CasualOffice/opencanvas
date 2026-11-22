// Starts the real stack for the suite and returns its teardown:
//   oc-server (release build, OC_DEV=1, temp SQLite)  on :8280
//   sample host (copy conflict policy)                 on :4200
//   sample host "reload" (reload conflict policy)      on :4201
//   mock model (Anthropic SSE, mock-model.ts)          on a free port; host "sample" has
//                                                      `[host.ai]` on it (t-assistant.real)
// Ports 8080/4000 (the dev defaults) are never touched, and only the processes
// started here are stopped.
//
//   E2E_SKIP_BUILD=1   reuse target/release/opencanvas and web/packages/editor/dist
//   E2E_KEEP=1         keep the temp dir (logs, DB, host data) after the run
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { HOST, HOST_RELOAD, OC, ROOT, SDK_HOST } from "./env";
import { startMockModel, type MockModel } from "./mock-model";

const children: ChildProcess[] = [];
let model: MockModel | null = null;

/** The assistant on the "sample" host, with the mock model's profile (t-assistant.real). */
const AI_HOST = `
[host.ai]
enabled  = true
provider = "mock"
`;

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(false)));
    s.once("error", () => resolve(true));
  });
}

function start(name: string, cmd: string, args: string[], env: Record<string, string>, logDir: string) {
  const log = fs.openSync(path.join(logDir, `${name}.log`), "a");
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", log, log] });
  p.once("exit", (code, sig) => {
    if (code !== null && code !== 0) console.error(`[e2e] ${name} exited with ${code ?? sig}; see ${logDir}/${name}.log`);
  });
  children.push(p);
  return p;
}

async function waitFor(url: string, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`[e2e] ${url} did not come up`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function stopAll() {
  for (const p of children) if (p.exitCode === null && !p.killed) p.kill("SIGTERM");
  void model?.close();
  model = null;
}

export default async function globalSetup() {
  for (const port of [8280, 4200, 4201, 4202]) {
    if (!(await portFree(port))) throw new Error(`[e2e] port ${port} is busy. Stop whatever runs there first (the suite never kills processes it didn't start).`);
  }
  if (process.env.E2E_SKIP_BUILD !== "1") {
    execSync("cargo build --release -p oc-server", { cwd: ROOT, stdio: "inherit" });
    execSync("pnpm --filter @opencanvas/editor build", { cwd: path.join(ROOT, "web"), stdio: "inherit" });
  }
  const bin = path.join(ROOT, "target/release/opencanvas");
  if (!fs.existsSync(bin)) throw new Error(`[e2e] ${bin} is missing; run without E2E_SKIP_BUILD`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-e2e-"));
  const hosts = path.join(tmp, "hosts.toml");
  const entry = (id: string, name: string, origin: string, policy: string, extra: string[] = [], ai = "") => `
[[host]]
id              = "${id}"
name            = "${name}"
mode            = "jwt"
jwt_alg         = "HS256"
jwt_secret      = "dev-secret-change-me"
api_key         = "dev-api-key-change-me"
callback_base   = "${origin}/api/opencanvas"
allowed_origins = ["${origin}"${extra.map((o) => `, "${o}"`).join("")}]

[host.flags]
export_formats = ["md", "html", "json", "docx", "pdf", "ocanvas", "svg", "png"]
on_conflict    = "${policy}"
${ai}`;
  fs.writeFileSync(hosts, entry("sample", "Sample host", HOST, "copy", [SDK_HOST], AI_HOST) + entry("sample-reload", "Reload host", HOST_RELOAD, "reload"));

  // The assistant against a mock model (t-assistant.real.spec.ts). Started before the server:
  // the server probes each provider's tool calling once, at start-up.
  model = await startMockModel();
  const aiConfig = path.join(tmp, "ai.toml");
  fs.writeFileSync(
    aiConfig,
    `[ai]\nenabled = true\n[ai.providers.mock]\nkind = "anthropic"\nbase_url = "${model.base}"\napi_key_env = "OC_E2E_AI_KEY"\nmodel_agent = "mock-agent"\ntimeout_secs = 10\n`,
  );

  start(
    "oc-server",
    bin,
    [],
    {
      OC_DEV: "1",
      OC_KEK: "",
      OC_HOSTS_FILE: hosts,
      OC_AI_CONFIG: aiConfig,
      OC_E2E_AI_KEY: "sk-e2e-mock",
      DATABASE_URL: `sqlite://${path.join(tmp, "oc.db")}?mode=rwc`,
      OC_BIND: "127.0.0.1:8280",
      OC_PUBLIC_URL: OC,
      OC_WEB_DIR: path.join(ROOT, "web/packages/editor/dist"),
      OC_AUTOSAVE_DEBOUNCE_MS: "500",
      OC_LOG: process.env.OC_LOG ?? "info",
    },
    tmp,
  );
  const host = (name: string, port: number, id: string) =>
    start(name, process.execPath, ["examples/sample-host/server.mjs"], {
      PORT: String(port),
      OC_SERVER: OC,
      OC_HOST_ID: id,
      DATA_DIR: path.join(tmp, name),
      SAMPLE_HOST_TEST: "1",
    }, tmp);
  host("host", 4200, "sample");
  host("host-reload", 4201, "sample-reload");
  process.once("exit", stopAll);

  try {
    await Promise.all([waitFor(`${OC}/readyz`), waitFor(`${HOST}/healthz`), waitFor(`${HOST_RELOAD}/healthz`)]);
  } catch (e) {
    stopAll();
    throw e;
  }
  process.env.E2E_TMP = tmp;
  console.log(`[e2e] stack up; logs and data in ${tmp}`);

  return async () => {
    stopAll();
    await Promise.all(children.map((p) => (p.exitCode !== null ? null : new Promise((r) => p.once("exit", r)))));
    if (process.env.E2E_KEEP !== "1") fs.rmSync(tmp, { recursive: true, force: true });
    else console.log(`[e2e] kept ${tmp}`);
  };
}
