/**
 * Per-request usage ledger.
 *
 * The CLI runs with --no-session-persistence, so nothing this proxy does shows
 * up in ~/.claude/projects. Without this ledger there is no way to tell which
 * caller spent the Max subscription's limit. One JSON line per request:
 * who called, which model, how many tokens.
 *
 * Writing must never break a request: every failure is swallowed.
 */

import { appendFile, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Request } from "express";
import type { ClaudeCliResult } from "../types/claude-cli.js";

export const USAGE_LOG_PATH =
  process.env.CLAUDE_PROXY_USAGE_LOG ||
  join(homedir(), ".openclaw", "logs", "claude-proxy-usage.jsonl");

export type UsageStatus = "ok" | "error" | "client_closed" | "no_result";

export interface UsageEntry {
  ts: string;
  request_id: string;
  caller: string;
  user_agent: string;
  owui_user: string | null;
  model_requested: string;
  model_alias: string;
  models_used: string[];
  stream: boolean;
  tools: number;
  messages: number;
  status: UsageStatus;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  api_equiv_usd: number;
  duration_ms: number;
}

const clip = (v: unknown, n: number): string =>
  typeof v === "string" ? v.replace(/[^\x20-\x7e]/g, "").slice(0, n) : "";

/**
 * Who sent the request. An explicit `X-Caller` header wins. Open WebUI is
 * recognised by its forwarded-user headers or its aiohttp client. Anything
 * else falls back to the User-Agent product token (Bun/…, Deno/…, curl/…).
 */
export function identifyCaller(headers: Record<string, unknown>): string {
  const explicit = clip(headers["x-caller"], 60);
  if (explicit) return explicit;
  if (headers["x-openwebui-user-name"] || headers["x-openwebui-user-id"]) return "open-webui";
  const ua = clip(headers["user-agent"], 200);
  if (/aiohttp/i.test(ua)) return "open-webui?";
  const product = ua.split(/\s+/)[0];
  return product ? `ua:${product}` : "unknown";
}

export interface UsageContext {
  requestId: string;
  headers: Record<string, unknown>;
  modelRequested: string;
  modelAlias: string;
  stream: boolean;
  tools: number;
  messages: number;
}

export function buildEntry(
  ctx: UsageContext,
  result: ClaudeCliResult | null,
  status: UsageStatus,
  startedAt: number,
  now: number = Date.now()
): UsageEntry {
  const u = result?.usage;
  return {
    ts: new Date(now).toISOString(),
    request_id: ctx.requestId,
    caller: identifyCaller(ctx.headers),
    user_agent: clip(ctx.headers["user-agent"], 120),
    owui_user: clip(ctx.headers["x-openwebui-user-name"], 60) || null,
    model_requested: clip(ctx.modelRequested, 60),
    model_alias: ctx.modelAlias,
    models_used: result?.modelUsage ? Object.keys(result.modelUsage) : [],
    stream: ctx.stream,
    tools: ctx.tools,
    messages: ctx.messages,
    status,
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    cache_creation_tokens: u?.cache_creation_input_tokens ?? 0,
    cache_read_tokens: u?.cache_read_input_tokens ?? 0,
    api_equiv_usd: Math.round((result?.total_cost_usd ?? 0) * 1e6) / 1e6,
    duration_ms: now - startedAt,
  };
}

let dirReady = false;

export function writeEntry(entry: UsageEntry, path: string = USAGE_LOG_PATH): void {
  try {
    if (!dirReady) {
      mkdirSync(dirname(path), { recursive: true });
      dirReady = true;
    }
    appendFile(path, JSON.stringify(entry) + "\n", (err) => {
      if (err) console.error("[Usage] append failed:", err.message);
    });
  } catch (err) {
    console.error("[Usage] write failed:", (err as Error).message);
  }
}

/**
 * Tracks one request. `finish` writes exactly once, whichever of
 * result / error / close fires first with the most information.
 */
export function startUsage(ctx: UsageContext, path?: string) {
  const startedAt = Date.now();
  let done = false;
  return {
    finish(result: ClaudeCliResult | null, status: UsageStatus): void {
      if (done) return;
      done = true;
      writeEntry(buildEntry(ctx, result, status, startedAt), path);
    },
  };
}

export function usageContext(req: Request, requestId: string, modelAlias: string): UsageContext {
  const body = (req.body ?? {}) as { model?: string; stream?: boolean; tools?: unknown[]; messages?: unknown[] };
  return {
    requestId,
    headers: req.headers as Record<string, unknown>,
    modelRequested: body.model ?? "",
    modelAlias,
    stream: body.stream === true,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    messages: Array.isArray(body.messages) ? body.messages.length : 0,
  };
}
