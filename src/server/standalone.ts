#!/usr/bin/env node
/**
 * Standalone server for testing without Clawdbot
 *
 * Usage:
 *   npm run start
 *   # or
 *   node dist/server/standalone.js [port]
 */

import { startServer, stopServer, inFlightCount } from "./index.js";
import { verifyClaude, verifyAuth } from "../subprocess/manager.js";

const DEFAULT_PORT = 3456;

async function main(): Promise<void> {
  console.log("Claude Code CLI Provider - Standalone Server");
  console.log("============================================\n");

  // Parse port from command line
  const port = parseInt(process.argv[2] || String(DEFAULT_PORT), 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${process.argv[2]}`);
    process.exit(1);
  }

  // Verify Claude CLI
  console.log("Checking Claude CLI...");
  const cliCheck = await verifyClaude();
  if (!cliCheck.ok) {
    console.error(`Error: ${cliCheck.error}`);
    process.exit(1);
  }
  console.log(`  Claude CLI: ${cliCheck.version || "OK"}`);

  // Verify authentication
  console.log("Checking authentication...");
  const authCheck = await verifyAuth();
  if (!authCheck.ok) {
    console.error(`Error: ${authCheck.error}`);
    console.error("Please run: claude auth login");
    process.exit(1);
  }
  console.log("  Authentication: OK\n");

  // Start server
  try {
    await startServer({ port });
    console.log("\nServer ready. Test with:");
    console.log(`  curl -X POST http://localhost:${port}/v1/chat/completions \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"model": "claude-sonnet-4", "messages": [{"role": "user", "content": "Hello!"}]}'`);
    console.log("\nPress Ctrl+C to stop.\n");
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }

  // Handle graceful shutdown.
  //
  // launchd sends SIGTERM and then SIGKILLs after ExitTimeOut, so the plist must
  // allow at least CLAUDE_PROXY_DRAIN_MS or the drain is pointless. A second
  // signal is treated as "I mean it" and exits immediately.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.error(`\n[${signal}] Second signal — exiting now.`);
      process.exit(0);
    }
    shuttingDown = true;
    console.error(
      `\n[${signal}] Shutting down; ${inFlightCount()} request(s) in flight.`
    );
    try {
      // launchd SIGKILLs 60s after SIGTERM and clamps ExitTimeOut to 60
      // regardless of the plist, so this budget must fit inside it. For a real
      // drain of long requests, use POST /admin/drain instead.
      await stopServer(Number(process.env.CLAUDE_PROXY_SIGTERM_DRAIN_MS || 55000));
    } catch (err) {
      console.error("[Shutdown] Error while draining:", err);
    }
    process.exit(0);
  };

  // Last resort. A single malformed CLI result used to crash the whole proxy and
  // drop every in-flight chat (see cli-to-openai normalizeModelName). Staying up
  // with one failed request beats taking everyone down.
  process.on("uncaughtException", (err) => {
    console.error("[FATAL-GUARD] Uncaught exception, staying up:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[FATAL-GUARD] Unhandled rejection, staying up:", reason);
  });

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
