/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import { buildToolInstructions, safeSplit, parseToolCalls } from "../adapter/tool-protocol.js";
import type { ClaudeCliAssistant, ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";
import { startUsage, usageContext } from "./usage-log.js";

type UsageTracker = ReturnType<typeof startUsage>;

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  try {
    // Validate request
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    // Convert to CLI input format
    const cliInput = openaiToCli(body);
    const subprocess = new ClaudeSubprocess();

    // The CLI runs with `--tools ""`, so tool calling is carried in the system
    // prompt and translated back on the way out. See adapter/tool-protocol.ts.
    const toolInstructions = buildToolInstructions(
      body.tools ?? [],
      body.tool_choice
    );
    const toolsEnabled = toolInstructions.length > 0;
    const usage = startUsage(usageContext(req, requestId, cliInput.model));
    if (toolsEnabled) {
      console.error(
        `[Tools] ${body.tools?.length} tool(s) offered: ` +
          `${body.tools?.map((t) => t.function.name).join(", ")}`
      );
    }

    if (stream) {
      await handleStreamingResponse(
        req, res, subprocess, cliInput, requestId, toolInstructions, toolsEnabled, usage
      );
    } else {
      await handleNonStreamingResponse(
        res, subprocess, cliInput, requestId, toolInstructions, toolsEnabled, usage
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string,
  toolInstructions: string,
  toolsEnabled: boolean,
  usage: UsageTracker
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);

  // CRITICAL: Flush headers immediately to establish SSE connection
  // Without this, headers are buffered and client times out waiting
  res.flushHeaders();

  // Send initial comment to confirm connection is alive
  res.write(":ok\n\n");

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    let lastModel = "claude-sonnet-4.6";
    let isComplete = false;
    // Tool mode: `holdBuf` withholds any suffix that might be the start of a
    // `<tool_call>` tag, so the literal syntax never reaches the chat window one
    // token at a time. `fullText` is what we parse once the model is done.
    let holdBuf = "";
    let fullText = "";

    const writeContent = (text: string) => {
      if (!text || res.writableEnded) return;
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: lastModel,
        choices: [{
          index: 0,
          delta: { role: isFirst ? "assistant" : undefined, content: text },
          finish_reason: null,
        }],
      })}\n\n`);
      isFirst = false;
    };

    // Handle actual client disconnect (response stream closed)
    res.on("close", () => {
      if (!isComplete) {
        // Client disconnected before response completed - kill subprocess
        subprocess.kill();
        usage.finish(null, "client_closed");
      }
      resolve();
    });

    // Handle streaming content deltas
    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const text = event.event.delta?.text || "";
      if (!text || res.writableEnded) return;
      if (!toolsEnabled) {
        writeContent(text);
        return;
      }
      fullText += text;
      holdBuf += text;
      const { emit, hold } = safeSplit(holdBuf);
      holdBuf = hold;
      writeContent(emit);
    });

    // Handle final assistant message (for model name)
    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      lastModel = message.message.model;
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      isComplete = true;
      usage.finish(result, result.is_error ? "error" : "ok");
      if (!res.writableEnded) {
        let finish: "stop" | "tool_calls" = "stop";
        if (toolsEnabled) {
          // Prefer the CLI's own final text: content_delta can be absent when the
          // reply is short enough to arrive as a single assistant message.
          const raw = fullText || result.result || "";
          const { toolCalls } = parseToolCalls(raw);
          if (toolCalls.length) {
            finish = "tool_calls";
            res.write(`data: ${JSON.stringify({
              id: `chatcmpl-${requestId}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: lastModel,
              choices: [{
                index: 0,
                delta: {
                  role: isFirst ? "assistant" : undefined,
                  tool_calls: toolCalls.map((tc, i) => ({
                    index: i,
                    id: tc.id,
                    type: "function" as const,
                    function: {
                      name: tc.function.name,
                      arguments: tc.function.arguments,
                    },
                  })),
                },
                finish_reason: null,
              }],
            })}\n\n`);
            isFirst = false;
          } else {
            // No call after all — release whatever was held back.
            writeContent(holdBuf);
            if (!fullText && result.result) writeContent(result.result);
          }
          holdBuf = "";
        }
        const doneChunk = createDoneChunk(requestId, lastModel, finish);
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      usage.finish(null, "error");
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      // Subprocess exited - ensure response is closed
      if (!isComplete) usage.finish(null, "no_result");
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          // Abnormal exit without result - send error
          res.write(`data: ${JSON.stringify({
            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
          })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    // Start the subprocess
    subprocess.start(cliInput.prompt, {
      model: cliInput.model,
      sessionId: cliInput.sessionId,
      systemPromptSuffix: toolInstructions,
      stdinMessages: cliInput.hasImages ? cliInput.stdinMessages : undefined,
    }).catch((err) => {
      console.error("[Streaming] Subprocess start error:", err);
      usage.finish(null, "error");
      reject(err);
    });
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string,
  toolInstructions: string,
  toolsEnabled: boolean,
  usage: UsageTracker
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      usage.finish(null, "error");
      res.status(500).json({
        error: {
          message: error.message,
          type: "server_error",
          code: null,
        },
      });
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      const r: ClaudeCliResult | null = finalResult;
      usage.finish(r, r ? (r.is_error ? "error" : "ok") : "no_result");
      if (finalResult) {
        // Anything thrown here escapes into an EventEmitter callback and becomes
        // an uncaught exception that kills the process for every concurrent user.
        try {
          res.json(cliResultToOpenai(finalResult, requestId, toolsEnabled));
        } catch (err) {
          console.error("[NonStreaming] Failed to convert CLI result:", err);
          if (!res.headersSent) {
            res.status(502).json({
              error: {
                message: "The model returned a response this proxy could not parse.",
                type: "server_error",
                code: "bad_cli_result",
              },
            });
          }
        }
      } else if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    // Start the subprocess
    subprocess
      .start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
        systemPromptSuffix: toolInstructions,
        stdinMessages: cliInput.hasImages ? cliInput.stdinMessages : undefined,
      })
      .catch((error) => {
        usage.finish(null, "error");
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
        resolve();
      });
  });
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req: Request, res: Response): void {
  res.json({
    object: "list",
    data: [
      {
        id: "claude-opus-4.8",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
      {
        id: "claude-sonnet-4.6",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
      {
        id: "claude-haiku-4.5",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
    ],
  });
}

/**
 * Handle POST /admin/drain
 *
 * launchd hard-clamps ExitTimeOut to 60s regardless of what the plist asks for,
 * so a SIGTERM can never protect a ten-minute deck build. Instead the process
 * drains and exits ON ITS OWN here, and launchd's KeepAlive restarts it. That
 * makes the drain budget ours, not launchd's.
 *
 * The listener binds 127.0.0.1 only, so this is not remotely reachable.
 */
export function handleDrain(_req: Request, res: Response): void {
  // Reply BEFORE draining: this request is itself counted as in-flight, so
  // waiting for it to finish inside the drain would deadlock until the budget
  // expired.
  res.status(202).json({ status: "draining" });
  res.on("finish", () => {
    setImmediate(async () => {
      const { stopServer } = await import("./index.js");
      await stopServer(Number(process.env.CLAUDE_PROXY_DRAIN_MS || 600000));
      console.error("[Drain] Exiting; launchd KeepAlive will restart.");
      process.exit(0);
    });
  });
}

/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  });
}
