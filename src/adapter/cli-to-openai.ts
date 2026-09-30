/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */

import type { ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type { OpenAIChatResponse, OpenAIChatChunk } from "../types/openai.js";
import { parseToolCalls } from "./tool-protocol.js";

/**
 * Extract JSON content from model response.
 * Claude often outputs prose before/after JSON in code fences.
 * This extracts the last JSON code fence block, or falls back to
 * finding a raw JSON object/array in the text.
 */
function stripCodeFences(text: string): string {
  if (!text) return "";
  // Find all code fence blocks and take the last one (most likely the JSON)
  const fenceMatches = [...text.matchAll(/```(?:\w*)\n([\s\S]*?)\n```/g)];
  if (fenceMatches.length > 0) {
    return fenceMatches[fenceMatches.length - 1][1];
  }

  // Try to extract a raw JSON object or array
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    try {
      JSON.parse(jsonMatch[1]);
      return jsonMatch[1];
    } catch {
      // Not valid JSON, return original
    }
  }

  return text;
}

/**
 * Extract text content from Claude CLI assistant message
 */
export function extractTextContent(message: ClaudeCliAssistant): string {
  return message.message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export function cliToOpenaiChunk(
  message: ClaudeCliAssistant,
  requestId: string,
  isFirst: boolean = false
): OpenAIChatChunk {
  const text = extractTextContent(message);

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(message.message.model),
    choices: [
      {
        index: 0,
        delta: {
          role: isFirst ? "assistant" : undefined,
          content: text,
        },
        finish_reason: message.message.stop_reason ? "stop" : null,
      },
    ],
  };
}

/**
 * Create a final "done" chunk for streaming
 */
export function createDoneChunk(
  requestId: string,
  model: string,
  finishReason: "stop" | "tool_calls" = "stop"
): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(model),
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
  };
}

/**
 * Convert Claude CLI result to OpenAI non-streaming response
 */
export function cliResultToOpenai(
  result: ClaudeCliResult,
  requestId: string,
  toolsEnabled: boolean = false
): OpenAIChatResponse {
  // When the CLI exits non-zero it still emits a result, but `modelUsage` can be
  // an EMPTY object — which is truthy, so `Object.keys({})[0]` was `undefined`
  // and normalizeModelName threw. That throw happened inside a subprocess "close"
  // handler, so it was an uncaught exception that killed the WHOLE proxy, taking
  // every concurrent chat down with it. Observed 5 times on 2026-09-24/25; the
  // user saw "Open WebUI: Server Connection Error" 5 times.
  const modelName =
    (result.modelUsage && Object.keys(result.modelUsage)[0]) || "claude-sonnet-4";

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(modelName),
    choices: [makeChoice(result.result, toolsEnabled)],
    usage: {
      prompt_tokens: result.usage?.input_tokens || 0,
      completion_tokens: result.usage?.output_tokens || 0,
      total_tokens:
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
    },
  };
}

/**
 * Build the response choice.
 *
 * When tools are in play the RAW text must be parsed first: `stripCodeFences`
 * hunts for a bare JSON object and would happily return the tool call's own
 * arguments with the sentinel tags stripped off, making the call undetectable.
 */
function makeChoice(
  raw: string | undefined | null,
  toolsEnabled: boolean
): OpenAIChatResponse["choices"][number] {
  raw = raw ?? "";
  if (toolsEnabled) {
    const { toolCalls, content } = parseToolCalls(raw ?? "");
    if (toolCalls.length) {
      return {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          tool_calls: toolCalls,
        },
        finish_reason: "tool_calls",
      };
    }
    return {
      index: 0,
      message: { role: "assistant", content: content },
      finish_reason: "stop",
    };
  }
  return {
    index: 0,
    message: { role: "assistant", content: stripCodeFences(raw) },
    finish_reason: "stop",
  };
}

/**
 * Normalize Claude model names to a consistent format
 * e.g., "claude-sonnet-4-5-20250929" -> "claude-sonnet-4"
 */
// Report the TIER, never a version. The CLI resolves `opus`/`sonnet`/`haiku` to
// whatever is current (today: claude-opus-5-5 / claude-sonnet-5), so any number
// baked in here is a number that will lie -- this returned "claude-opus-4" while
// actually serving Opus 5.5. The real model is still in the proxy logs.
function normalizeModelName(model?: string | null): string {
  if (!model) return "claude-sonnet";
  if (model.includes("opus")) return "claude-opus";
  if (model.includes("sonnet")) return "claude-sonnet";
  if (model.includes("haiku")) return "claude-haiku";
  return model;
}
