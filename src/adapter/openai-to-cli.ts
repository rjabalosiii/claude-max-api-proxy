/**
 * Converts OpenAI chat request format to Claude CLI input
 *
 * Supports two modes:
 * - Text-only: prompt passed as CLI argument (legacy)
 * - Stream-JSON: NDJSON piped to stdin with full multimodal support (images)
 */

import type { OpenAIChatRequest, OpenAIChatContentPart } from "../types/openai.js";

export type ClaudeModel = "opus" | "sonnet" | "haiku";

/**
 * Claude CLI stream-json content block types
 */
interface CliTextContent {
  type: "text";
  text: string;
}

interface CliImageContent {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

interface CliDocumentContent {
  type: "document";
  source: {
    type: "base64";
    media_type: "application/pdf";
    data: string;
  };
}

type CliContentBlock = CliTextContent | CliImageContent | CliDocumentContent;

/**
 * NDJSON message format for Claude CLI --input-format stream-json
 */
export interface CliStreamMessage {
  type: "user";
  message: {
    role: "user";
    content: CliContentBlock[];
  };
}

export interface CliInput {
  /** Single prompt string (legacy text-only mode) */
  prompt: string;
  /** NDJSON lines for stdin piping (stream-json mode with image support) */
  stdinMessages: string[];
  /** Whether the request contains images and needs stream-json mode */
  hasImages: boolean;
  model: ClaudeModel;
  sessionId?: string;
}

const MODEL_MAP: Record<string, ClaudeModel> = {
  // Direct model names (current)
  "claude-opus-4.8": "opus",
  "claude-sonnet-4.6": "sonnet",
  "claude-haiku-4.5": "haiku",
  // Legacy model names (backwards compat)
  "claude-opus-4.6": "opus",
  "claude-haiku-4": "haiku",
  "claude-opus-4": "opus",
  "claude-sonnet-4": "sonnet",
  // With provider prefix
  "claude-code-cli/claude-opus-4.8": "opus",
  "claude-code-cli/claude-sonnet-4.6": "sonnet",
  "claude-code-cli/claude-haiku-4.5": "haiku",
  "claude-code-cli/claude-opus-4.6": "opus",
  "claude-code-cli/claude-haiku-4": "haiku",
  "claude-code-cli/claude-opus-4": "opus",
  "claude-code-cli/claude-sonnet-4": "sonnet",
  // Aliases
  "opus": "opus",
  "sonnet": "sonnet",
  "haiku": "haiku",
};

/**
 * Extract Claude model alias from request model string
 */
export function extractModel(model: string): ClaudeModel {
  if (MODEL_MAP[model]) {
    return MODEL_MAP[model];
  }
  const stripped = model.replace(/^claude-code-cli\//, "");
  if (MODEL_MAP[stripped]) {
    return MODEL_MAP[stripped];
  }
  return "opus";
}

/**
 * Check if any message in the request contains multimodal content (images or PDFs)
 */
function requestHasMultimodal(messages: OpenAIChatRequest["messages"]): boolean {
  return messages.some((msg) => {
    if (typeof msg.content === "string") return false;
    return msg.content.some((part) => part.type === "image_url");
  });
}

/**
 * Extract text from content (string or array of content parts).
 */
function extractText(content: string | OpenAIChatContentPart[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text!)
    .join("\n");
}

/**
 * Convert an OpenAI image_url to a Claude CLI base64 content block.
 * Handles data URIs for both images (data:image/png;base64,...) and PDFs (data:application/pdf;base64,...).
 */
function convertMediaPart(part: OpenAIChatContentPart): CliContentBlock | null {
  if (part.type !== "image_url" || !part.image_url) return null;

  const url = part.image_url.url;

  // Check for PDF data URI first: data:application/pdf;base64,...
  const pdfMatch = url.match(/^data:application\/pdf;base64,(.+)$/i);
  if (pdfMatch) {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: pdfMatch[1],
      },
    };
  }

  // Parse image data URI: data:image/png;base64,iVBOR...
  const match = url.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!match) {
    // Non-data-URI images (http URLs) are not supported by CLI
    console.error("[openai-to-cli] Skipping non-data-URI media:", url.slice(0, 60));
    return null;
  }

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: match[1],
      data: match[2],
    },
  };
}

/**
 * Convert OpenAI content parts to Claude CLI content blocks
 */
function convertContentParts(content: string | OpenAIChatContentPart[]): CliContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  const blocks: CliContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text) {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      const media = convertMediaPart(part);
      if (media) blocks.push(media);
    }
  }
  return blocks;
}

/**
 * Convert OpenAI messages to Claude CLI stream-json NDJSON lines.
 *
 * Claude CLI stream-json only accepts "user" role messages.
 * System and assistant messages are inlined as tagged text blocks
 * within the user message content.
 */
function messagesToStreamJson(messages: OpenAIChatRequest["messages"]): string[] {
  // Collect all content blocks into a single user message
  // (Claude CLI stream-json expects user-role messages only)
  const allBlocks: CliContentBlock[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system": {
        const text = extractText(msg.content);
        allBlocks.push({ type: "text", text: `<system>\n${text}\n</system>` });
        break;
      }
      case "assistant": {
        const text = extractText(msg.content);
        allBlocks.push({ type: "text", text: `<previous_response>\n${text}\n</previous_response>` });
        break;
      }
      case "user": {
        const blocks = convertContentParts(msg.content);
        allBlocks.push(...blocks);
        break;
      }
    }
  }

  const stdinMsg: CliStreamMessage = {
    type: "user",
    message: {
      role: "user",
      content: allBlocks,
    },
  };

  return [JSON.stringify(stdinMsg)];
}

/**
 * Convert OpenAI messages to a single prompt string (legacy text-only mode)
 */
export function messagesToPrompt(messages: OpenAIChatRequest["messages"]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const text = extractText(msg.content);
    switch (msg.role) {
      case "system":
        parts.push(`<system>\n${text}\n</system>\n`);
        break;
      case "user":
        parts.push(text);
        break;
      case "assistant":
        parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        break;
    }
  }

  return parts.join("\n").trim();
}

/**
 * Convert OpenAI chat request to CLI input format.
 * Automatically chooses stream-json mode when images are present.
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  const hasImages = requestHasMultimodal(request.messages);

  return {
    prompt: messagesToPrompt(request.messages),
    stdinMessages: messagesToStreamJson(request.messages),
    hasImages,
    model: extractModel(request.model),
    sessionId: request.user,
  };
}
