// A tiny mock model server in the Anthropic Messages SSE format (as in
// crates/oc-server/tests/ai_e2e.rs), for t-assistant.real.spec.ts. It is stateless: each answer
// is chosen from the request body, so one instance serves every run of the suite.
//
//   probe request             → calls the `probe` tool (the server's start-up capability probe)
//   "First write a short plan" → a 3-line plan (read, create, create)
//   then, by the number of tool results in the conversation:
//     0 → canvas_read, 1 → db_create "Tasks", 2 → db_upsert_rows (2 rows), 3+ → a closing line
//
// The server probes its providers once, at start-up, so global-setup.ts starts this before the
// server (on a free port) and writes the `OC_AI_CONFIG` that points at it.
import http from "node:http";
import type { AddressInfo } from "node:net";

type Step = { text: string } | { tool: string; input: unknown };

export const MOCK_PLAN = ["Read the canvas", "Create a Tasks database", "Add the task rows"];
export const MOCK_ROWS = ["Write the e2e test", "Ship the assistant"];

function dbId(body: string): string {
  const at = body.indexOf("dbId");
  if (at < 0) throw new Error("db_create result missing from the request");
  return /^[\\":\s]*([A-Za-z0-9_-]+)/.exec(body.slice(at + 4))![1];
}

function nextStep(body: string): Step {
  if (body.includes("capability probe")) return { tool: "probe", input: { ok: true } };
  if (body.includes("First write a short plan")) return { text: MOCK_PLAN.map((l, i) => `${i + 1}. ${l}`).join("\n") };
  const done = body.split('"tool_result"').length - 1;
  if (done === 0) return { tool: "canvas_read", input: {} };
  if (done === 1)
    return {
      tool: "db_create",
      input: { name: "Tasks", fields: [{ name: "Task", type: "title" }, { name: "Status", type: "status", options: ["Todo", "Done"] }] },
    };
  if (done === 2)
    return { tool: "db_upsert_rows", input: { dbId: dbId(body), rows: MOCK_ROWS.map((t, i) => ({ values: { Task: t, Status: i ? "Done" : "Todo" } })) } };
  return { text: `Created Tasks with ${MOCK_ROWS.length} rows.` };
}

function sse(step: Step): string {
  const ev: [string, unknown][] = [["message_start", { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } }]];
  if ("text" in step) {
    ev.push(["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }]);
    ev.push(["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: step.text } }]);
  } else {
    const id = `toolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    ev.push(["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: step.tool, input: {} } }]);
    ev.push(["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.input) } }]);
  }
  ev.push(["content_block_stop", { type: "content_block_stop", index: 0 }]);
  ev.push(["message_delta", { type: "message_delta", delta: { stop_reason: "text" in step ? "end_turn" : "tool_use" }, usage: { output_tokens: 5 } }]);
  ev.push(["message_stop", { type: "message_stop" }]);
  return ev.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}

export interface MockModel {
  base: string;
  close(): Promise<void>;
}

export async function startMockModel(): Promise<MockModel> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" }).end(sse(nextStep(body)));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((ok) => server.close(() => ok())) };
}
