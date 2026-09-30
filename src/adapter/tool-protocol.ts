/**
 * Tool calling over a CLI that has no tool support.
 *
 * The Claude CLI is spawned with `--tools ""` (it acts as a plain chat model), so
 * native tool use is unavailable. Rather than leave every Claude model in the
 * client unable to call tools, we carry the OpenAI tool contract in the system
 * prompt and translate the model's reply back into real `tool_calls`.
 *
 * The wire format is the widely-used sentinel block:
 *
 *     <tool_call>
 *     {"name": "build_presentation", "arguments": {"topic": "..."}}
 *     </tool_call>
 *
 * It is chosen over "reply with only JSON" because it survives the model adding
 * prose around it, which it often does, and because it is trivially detectable
 * mid-stream — see `safeSplit`.
 */

import type {
  OpenAITool,
  OpenAIToolCall,
  OpenAIToolChoice,
} from "../types/openai.js";

export const OPEN_TAG = "<tool_call>";
export const CLOSE_TAG = "</tool_call>";

/**
 * Build the system-prompt contract describing the callable tools.
 */
export function buildToolInstructions(
  tools: OpenAITool[],
  toolChoice?: OpenAIToolChoice
): string {
  if (!tools?.length) return "";

  const specs = tools
    .map((t) => {
      const fn = t.function;
      const params = fn.parameters
        ? JSON.stringify(fn.parameters)
        : '{"type":"object","properties":{}}';
      return `- ${fn.name}: ${fn.description || "(no description)"}\n  parameters (JSON Schema): ${params}`;
    })
    .join("\n");

  let mandate =
    "Call a tool ONLY when it is genuinely needed to answer. Otherwise reply normally.";
  if (toolChoice === "required") {
    mandate = "You MUST call one of the tools below. Do not answer without calling one.";
  } else if (toolChoice === "none") {
    return "";
  } else if (typeof toolChoice === "object" && toolChoice?.function?.name) {
    mandate = `You MUST call the tool "${toolChoice.function.name}".`;
  }

  return `

# Tools

You can call the following tools:

${specs}

${mandate}

To call a tool, emit a block in EXACTLY this format:

${OPEN_TAG}
{"name": "<tool name>", "arguments": {<arguments matching the schema>}}
${CLOSE_TAG}

Rules:
- The block content must be a single line of strict JSON. No comments, no trailing commas.
- "arguments" is an OBJECT, never a string.
- Emit the block and then STOP. Do not describe the call, do not predict its result,
  and do not write any text after the closing tag.
- Never invent a tool that is not listed above.
- After a tool result is provided to you, answer the user using that result. Do not
  call the same tool again with the same arguments.`;
}

/**
 * Split a streaming buffer into the part that is definitely plain content and a
 * suffix that must be held back because it may be the beginning of a tool call.
 *
 * Without this, the literal text "<tool_call>" leaks into the user's chat window
 * one token at a time before we can tell what it is.
 */
export function safeSplit(buf: string): { emit: string; hold: string } {
  const idx = buf.indexOf(OPEN_TAG);
  if (idx !== -1) {
    return { emit: buf.slice(0, idx), hold: buf.slice(idx) };
  }
  // Hold back any suffix that could still grow into OPEN_TAG.
  const max = Math.min(buf.length, OPEN_TAG.length - 1);
  for (let n = max; n > 0; n--) {
    if (buf.endsWith(OPEN_TAG.slice(0, n))) {
      return { emit: buf.slice(0, buf.length - n), hold: buf.slice(buf.length - n) };
    }
  }
  return { emit: buf, hold: "" };
}

let counter = 0;
function nextCallId(): string {
  counter = (counter + 1) % 1_000_000;
  return `call_${Date.now().toString(36)}${counter.toString(36).padStart(4, "0")}`;
}

/** Reset the id counter. Test seam only. */
export function __resetCallIds(): void {
  counter = 0;
}

/**
 * Extract every tool call from a completed response.
 *
 * Returns the calls plus the response text with the blocks removed, because
 * OpenAI allows an assistant turn to carry both content and tool_calls.
 */
export function parseToolCalls(text: string): {
  toolCalls: OpenAIToolCall[];
  content: string;
} {
  const toolCalls: OpenAIToolCall[] = [];
  let content = "";
  let rest = text;

  for (;;) {
    const start = rest.indexOf(OPEN_TAG);
    if (start === -1) {
      content += rest;
      break;
    }
    content += rest.slice(0, start);
    const after = rest.slice(start + OPEN_TAG.length);
    const end = after.indexOf(CLOSE_TAG);
    // An unterminated block means the model was cut off. Take the remainder and
    // stop; a truncated call is better recovered than silently shown as prose.
    const bodyRaw = end === -1 ? after : after.slice(0, end);
    rest = end === -1 ? "" : after.slice(end + CLOSE_TAG.length);

    const parsed = parseCallBody(bodyRaw);
    if (parsed) {
      toolCalls.push(parsed);
    } else {
      // Not parseable as a call — keep it visible rather than swallowing output.
      content += OPEN_TAG + bodyRaw + (end === -1 ? "" : CLOSE_TAG);
    }
    if (end === -1) break;
  }

  return { toolCalls, content: content.trim() };
}

function parseCallBody(bodyRaw: string): OpenAIToolCall | null {
  let body = bodyRaw.trim();
  // Models sometimes wrap the JSON in a code fence despite the instruction.
  if (body.startsWith("```")) {
    body = body.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
  }
  if (!body) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(body);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  const rec = obj as Record<string, unknown>;
  const name = typeof rec.name === "string" ? rec.name : null;
  if (!name) return null;

  // "arguments" should be an object, but accept a JSON string too — models
  // trained on the OpenAI wire format emit the stringified form.
  let args = rec.arguments ?? rec.parameters ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      /* keep the raw string below */
    }
  }

  return {
    id: nextCallId(),
    type: "function",
    function: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    },
  };
}
