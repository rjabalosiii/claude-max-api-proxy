import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identifyCaller, buildEntry, startUsage, type UsageContext } from "./usage-log.js";
import type { ClaudeCliResult } from "../types/claude-cli.js";

const ctx = (headers: Record<string, unknown>): UsageContext => ({
  requestId: "req1",
  headers,
  modelRequested: "claude-opus-4.8",
  modelAlias: "opus",
  stream: true,
  tools: 2,
  messages: 5,
});

const result = (over: Partial<ClaudeCliResult> = {}): ClaudeCliResult => ({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 10,
  duration_api_ms: 9,
  num_turns: 1,
  result: "hi",
  session_id: "s",
  total_cost_usd: 0.0123456789,
  usage: { input_tokens: 3, output_tokens: 40, cache_creation_input_tokens: 5000, cache_read_input_tokens: 200 },
  modelUsage: { "claude-opus-5-5": { inputTokens: 3, outputTokens: 40, costUSD: 0.01 } },
  ...over,
});

test("identifyCaller: explicit X-Caller wins", () => {
  assert.equal(identifyCaller({ "x-caller": "rr-classifier:email", "user-agent": "Bun/1.3.1" }), "rr-classifier:email");
});

test("identifyCaller: Open WebUI by forwarded user header or aiohttp", () => {
  assert.equal(identifyCaller({ "x-openwebui-user-name": "Someone" }), "open-webui");
  assert.equal(identifyCaller({ "user-agent": "Python/3.11 aiohttp/3.11.18" }), "open-webui?");
});

test("identifyCaller: falls back to the UA product token, then unknown", () => {
  assert.equal(identifyCaller({ "user-agent": "Bun/1.3.1" }), "ua:Bun/1.3.1");
  assert.equal(identifyCaller({}), "unknown");
});

test("identifyCaller: strips control characters and caps length", () => {
  assert.equal(identifyCaller({ "x-caller": "a\nb" + "x".repeat(100) }), ("ab" + "x".repeat(100)).slice(0, 60));
});

test("buildEntry: copies tokens, models and cost", () => {
  const e = buildEntry(ctx({ "x-caller": "tabbrain" }), result(), "ok", 1000, 1500);
  assert.equal(e.caller, "tabbrain");
  assert.equal(e.model_alias, "opus");
  assert.deepEqual(e.models_used, ["claude-opus-5-5"]);
  assert.equal(e.input_tokens, 3);
  assert.equal(e.output_tokens, 40);
  assert.equal(e.cache_creation_tokens, 5000);
  assert.equal(e.cache_read_tokens, 200);
  assert.equal(e.api_equiv_usd, 0.012346);
  assert.equal(e.duration_ms, 500);
  assert.equal(e.tools, 2);
  assert.equal(e.messages, 5);
});

test("buildEntry: no result gives zeros, not a throw", () => {
  const e = buildEntry(ctx({}), null, "client_closed", 0, 1);
  assert.equal(e.status, "client_closed");
  assert.equal(e.input_tokens, 0);
  assert.deepEqual(e.models_used, []);
});

test("buildEntry: a result missing usage/modelUsage does not throw", () => {
  const r = result({ usage: undefined as never, modelUsage: undefined as never, total_cost_usd: undefined as never });
  const e = buildEntry(ctx({}), r, "ok", 0, 1);
  assert.equal(e.output_tokens, 0);
  assert.equal(e.api_equiv_usd, 0);
});

test("startUsage: writes exactly one line even if finish is called twice", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "usage-")), "sub", "u.jsonl");
  const u = startUsage(ctx({ "x-caller": "t" }), path);
  u.finish(result(), "ok");
  u.finish(null, "client_closed");
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(path));
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).status, "ok");
});
