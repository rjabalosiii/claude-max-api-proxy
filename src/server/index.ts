/**
 * Express HTTP Server
 *
 * Provides OpenAI-compatible API endpoints that wrap Claude Code CLI
 */

import express, { Express, Request, Response, NextFunction } from "express";
import { createServer, Server } from "http";
import { handleChatCompletions, handleModels, handleHealth, handleDrain } from "./routes.js";

export interface ServerConfig {
  port: number;
  host?: string;
}

let serverInstance: Server | null = null;

/**
 * Graceful shutdown state.
 *
 * A plain `kickstart -k` (or any SIGTERM) used to sever responses mid-body. The
 * client saw `TransferEncodingError: Not enough data to satisfy transfer length
 * header`, and in Open WebUI the aborted save left an orphaned message whose
 * parent no longer existed — the chat then refused to load or regenerate with
 * "Parent message not found". A deck build or a long research answer can run for
 * many minutes, so shutdown must DRAIN rather than cut.
 */
let draining = false;
let inFlight = 0;
const sockets = new Set<import("net").Socket>();
/** Sockets currently carrying a request; the rest are idle keep-alives. */
const busySockets = new Set<import("net").Socket>();

export function isDraining(): boolean {
  return draining;
}

export function inFlightCount(): number {
  return inFlight;
}

/**
 * Create and configure the Express app
 */
function createApp(): Express {
  const app = express();

  // In-flight accounting must wrap EVERY request, so it goes first.
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Liveness probes must keep succeeding while draining. The healthcheck
    // (open-webui-healthcheck.sh CHECK 1) polls GET /v1/models and treats any
    // non-200 as "proxy is down", then runs `kickstart -k` — which SIGTERMs the
    // very drain in progress and severs the request we were protecting.
    // Observed exactly that: a 600s drain replaced by a 55s one, mid-answer.
    const isProbe =
      req.method === "GET" && (req.path === "/health" || req.path === "/v1/models");

    if (draining && !isProbe) {
      // Refuse new WORK while draining; in-flight requests keep streaming.
      res.setHeader("Connection", "close");
      res.status(503).json({
        error: {
          message: "Server is shutting down; retry in a moment.",
          type: "server_error",
          code: "draining",
        },
      });
      return;
    }
    inFlight++;
    const socket = req.socket;
    busySockets.add(socket);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      inFlight--;
      busySockets.delete(socket);
    };
    // "finish" covers normal completion; "close" covers SSE and client aborts,
    // where "finish" may never fire.
    res.on("finish", finish);
    res.on("close", finish);
    next();
  });

  // Middleware
  app.use(express.json({ limit: "50mb" })); // Large limit for base64 images

  // Request logging (debug mode)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (process.env.DEBUG) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
    next();
  });

  // CORS headers for local development
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    next();
  });

  // Handle OPTIONS preflight
  app.options("*", (_req: Request, res: Response) => {
    res.sendStatus(200);
  });

  // Routes
  app.get("/health", handleHealth);
  app.post("/admin/drain", handleDrain);
  app.get("/v1/models", handleModels);
  app.post("/v1/chat/completions", handleChatCompletions);

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        message: "Not found",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[Server Error]:", err.message);
    res.status(500).json({
      error: {
        message: err.message,
        type: "server_error",
        code: null,
      },
    });
  });

  return app;
}

/**
 * Start the HTTP server
 */
export async function startServer(config: ServerConfig): Promise<Server> {
  const { port, host = "127.0.0.1" } = config;

  if (serverInstance) {
    console.log("[Server] Already running, returning existing instance");
    return serverInstance;
  }

  const app = createApp();

  return new Promise((resolve, reject) => {
    serverInstance = createServer(app);

    serverInstance.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });

    serverInstance.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
        busySockets.delete(socket);
      });
    });

    serverInstance.listen(port, host, () => {
      console.log(`[Server] Claude Code CLI provider running at http://${host}:${port}`);
      console.log(`[Server] OpenAI-compatible endpoint: http://${host}:${port}/v1/chat/completions`);
      resolve(serverInstance!);
    });
  });
}

/**
 * Stop the HTTP server
 */
export async function stopServer(drainMs?: number): Promise<void> {
  if (!serverInstance) {
    return;
  }

  const budget = drainMs ?? Number(process.env.CLAUDE_PROXY_DRAIN_MS || 600000);
  const server = serverInstance;
  draining = true;

  // Deliberately do NOT close the listener yet.
  //
  // `server.close()` unbinds the port immediately. The healthcheck then cannot
  // connect at all and records HTTP 000 — not 503 — so the probe exemption above
  // is never even reached, and it runs `kickstart -k`. That SIGTERM lands on the
  // process still draining and cuts the response we were protecting. Observed
  // exactly that, twice: a 600s drain replaced by a 55s one, mid-answer.
  //
  // Instead: stay bound and keep answering probes; refuse new WORK at the
  // application layer (see the draining middleware); close only once drained.
  if (inFlight > 0) {
    console.error(
      `[Server] Draining ${inFlight} in-flight request(s), up to ${Math.round(
        budget / 1000
      )}s...`
    );
  }

  const deadline = Date.now() + budget;
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }

  if (inFlight > 0) {
    console.error(
      `[Server] Drain budget exhausted with ${inFlight} request(s) still open; closing anyway.`
    );
  } else {
    console.error("[Server] All requests completed cleanly");
  }

  // Now it is safe to unbind and drop sockets.
  await new Promise<void>((resolve) => {
    server.close(() => {
      console.error("[Server] Listener closed");
      resolve();
    });
    // Idle keep-alives would otherwise hold close() open forever.
    for (const s of sockets) {
      if (!busySockets.has(s)) s.destroy();
    }
  });

  for (const s of sockets) s.destroy();
  sockets.clear();
  busySockets.clear();
  serverInstance = null;
  draining = false;
  console.log("[Server] Stopped");
}

/**
 * Get the current server instance
 */
export function getServer(): Server | null {
  return serverInstance;
}
