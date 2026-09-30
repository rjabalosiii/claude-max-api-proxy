import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildToolInstructions,
  safeSplit,
  parseToolCalls,
  OPEN_TAG,
  CLOSE_TAG,
} from "./tool-protocol.js";
import type { OpenAITool } from "../types/openai.js";

const TOOLS: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "build_presentation",
      description: "Build a PowerPoint deck",
      parameters: {
        type: "object",
        properties: { topic: { type: "string" }, slides: { type: "integer" } },
        required: ["topic"],
      },
    },
  },
];

/** Feed text through safeSplit one character at a time, as a real stream would. */
function streamThrough(text: string): { emitted: string; held: string } {
  let hold = "";
  let emitted = "";
  for (const ch of text) {
    hold += ch;
    const r = safeSplit(hold);
    hold = r.hold;
    emitted += r.emit;
  }
  return { emitted, held: hold };
}

test("instructions name each tool and its schema", () => {
  const s = buildToolInstructions(TOOLS, "auto");
  assert.ok(s.includes("build_presentation"));
  assert.ok(s.includes('"topic"'));
  assert.ok(s.includes(OPEN_TAG));
});

test("tool_choice none disables tools entirely", () => {
  assert.equal(buildToolInstructions(TOOLS, "none"), "");
});

test("tool_choice required and named produce a mandate", () => {
  assert.ok(buildToolInstructions(TOOLS, "required").includes("MUST"));
  assert.ok(
    buildToolInstructions(TOOLS, {
      type: "function",
      function: { name: "build_presentation" },
    }).includes('"build_presentation"')
  );
});

test("no tools means no instructions", () => {
  assert.equal(buildToolInstructions([], "auto"), "");
});

// --- the leak guard -------------------------------------------------------

test("STREAMING: the open tag never leaks, char by char", () => {
  const reply = `Sure, building that now.\n${OPEN_TAG}\n{"name":"build_presentation","arguments":{"topic":"Anemia"}}\n${CLOSE_TAG}`;
  const { emitted } = streamThrough(reply);
  assert.ok(!emitted.includes("<tool_call"), `leaked: ${JSON.stringify(emitted)}`);
  assert.ok(!emitted.includes("build_presentation"));
  assert.equal(emitted, "Sure, building that now.\n");
});

test("STREAMING: a partial tag at the end is withheld, not shown", () => {
  const { emitted, held } = streamThrough("hello <tool_c");
  assert.equal(emitted, "hello ");
  assert.equal(held, "<tool_c");
});

test("STREAMING: ordinary text with a lone angle bracket still flows", () => {
  const { emitted, held } = streamThrough("if a < b then x > y");
  assert.equal(emitted, "if a < b then x > y");
  assert.equal(held, "");
});

test("STREAMING: text mentioning tool but not the tag is not withheld", () => {
  const { emitted } = streamThrough("Use the <tool> element carefully");
  assert.equal(emitted, "Use the <tool> element carefully");
});

// --- parsing --------------------------------------------------------------

test("parses a well-formed call", () => {
  const { toolCalls, content } = parseToolCalls(
    `${OPEN_TAG}\n{"name":"build_presentation","arguments":{"topic":"Anemia","slides":5}}\n${CLOSE_TAG}`
  );
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, "build_presentation");
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), {
    topic: "Anemia",
    slides: 5,
  });
  assert.equal(content, "");
  assert.ok(toolCalls[0].id.startsWith("call_"));
});

test("keeps prose that surrounds the call", () => {
  const { toolCalls, content } = parseToolCalls(
    `One moment.\n${OPEN_TAG}{"name":"build_presentation","arguments":{"topic":"X"}}${CLOSE_TAG}`
  );
  assert.equal(toolCalls.length, 1);
  assert.equal(content, "One moment.");
});

test("accepts stringified arguments (OpenAI wire habit)", () => {
  const { toolCalls } = parseToolCalls(
    `${OPEN_TAG}{"name":"f","arguments":"{\\"topic\\":\\"Y\\"}"}${CLOSE_TAG}`
  );
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { topic: "Y" });
});

test("accepts a code-fenced body despite the instruction", () => {
  const { toolCalls } = parseToolCalls(
    `${OPEN_TAG}\n\`\`\`json\n{"name":"f","arguments":{"a":1}}\n\`\`\`\n${CLOSE_TAG}`
  );
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, "f");
});

test("parses two calls in one reply", () => {
  const { toolCalls } = parseToolCalls(
    `${OPEN_TAG}{"name":"a","arguments":{}}${CLOSE_TAG}${OPEN_TAG}{"name":"b","arguments":{}}${CLOSE_TAG}`
  );
  assert.deepEqual(toolCalls.map((t) => t.function.name), ["a", "b"]);
});

test("plain prose yields no calls and loses nothing", () => {
  const { toolCalls, content } = parseToolCalls("Just a normal answer.");
  assert.equal(toolCalls.length, 0);
  assert.equal(content, "Just a normal answer.");
});

test("malformed JSON is shown, not silently swallowed", () => {
  const { toolCalls, content } = parseToolCalls(
    `${OPEN_TAG}{not json}${CLOSE_TAG}`
  );
  assert.equal(toolCalls.length, 0);
  assert.ok(content.includes("not json"));
});

test("a truncated call is still recovered", () => {
  const { toolCalls } = parseToolCalls(
    `${OPEN_TAG}\n{"name":"build_presentation","arguments":{"topic":"Z"}}`
  );
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, "build_presentation");
});

test("a call with no name is not a call", () => {
  const { toolCalls } = parseToolCalls(`${OPEN_TAG}{"arguments":{}}${CLOSE_TAG}`);
  assert.equal(toolCalls.length, 0);
});

test("ids are unique across calls", () => {
  const { toolCalls } = parseToolCalls(
    `${OPEN_TAG}{"name":"a","arguments":{}}${CLOSE_TAG}${OPEN_TAG}{"name":"b","arguments":{}}${CLOSE_TAG}`
  );
  assert.notEqual(toolCalls[0].id, toolCalls[1].id);
});

// --- regression: the crash that took the proxy down on 2026-09-24 -----------
import { cliResultToOpenai } from "./cli-to-openai.js";

test("REGRESSION: empty modelUsage does not throw (killed the proxy 5x)", () => {
  const r = cliResultToOpenai(
    { modelUsage: {}, result: "hello" } as never, "req1", false);
  assert.equal(r.model, "claude-sonnet");
  assert.equal(r.choices[0].message.content, "hello");
});

test("REGRESSION: missing result text does not throw", () => {
  const r = cliResultToOpenai({ modelUsage: {} } as never, "req2", false);
  assert.equal(r.choices[0].message.content, "");
});

test("REGRESSION: missing modelUsage entirely does not throw", () => {
  const r = cliResultToOpenai({ result: "x" } as never, "req3", false);
  assert.equal(r.model, "claude-sonnet");
});

test("REGRESSION: empty modelUsage with tools enabled does not throw", () => {
  const r = cliResultToOpenai({ modelUsage: {} } as never, "req4", true);
  assert.equal(r.choices[0].finish_reason, "stop");
});
