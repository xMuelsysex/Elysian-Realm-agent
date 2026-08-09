import { createAdaptorServer } from "@hono/node-server";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { streamSSE } from "hono/streaming";
import {
  RealmConversationValidationError,
  executeRealmConversationV1,
} from "./realmConversationExecutor.js";
import {
  RealmAgentStepValidationError,
  executeRealmAgentStepV1,
} from "./realmStepExecutor.js";
import type { ConversationRunner } from "../conversation/conversationRunner.js";

export const AGENT_SERVICE_NAME = "elysian-realm-agent";
export const DEFAULT_AGENT_SERVICE_HOST = "127.0.0.1";
export const DEFAULT_AGENT_SERVICE_PORT = 4318;
const MAX_BODY_BYTES = 1024 * 1024;

export interface AgentServiceConfig {
  host: string;
  port: number;
}

/**
 * Result of an admin API call, or undefined when the handler does not own the
 * route. Pure data so the service barrel stays free of pi imports; the real
 * handler is assembled in "./service/bootstrap".
 */
export type AdminRequestResult = AdminJsonResult | AdminStreamResult;

export interface AdminJsonResult {
  status: number;
  body: unknown;
}

/**
 * SSE result: the service writes each emitted frame as an
 * `event: <name>\ndata: <json>\n\n` chunk with `text/event-stream`.
 */
export interface AdminStreamResult {
  status: number;
  stream: (emit: (event: string, data: unknown) => void) => Promise<void>;
}

export type AdminRequestHandler = (
  method: string,
  path: string,
  body: unknown,
) => Promise<AdminRequestResult | undefined>;

export interface AdminOptions {
  handler: AdminRequestHandler;
  /** HTML served at the extension's page path. */
  page?: string;
  /**
   * Bearer token required for every route of this extension. The assembly
   * point decides: loopback binds may omit it; non-loopback binds must set
   * one (main.ts refuses to enable the extension without it).
   */
  token?: string;
}

/**
 * Optional service capabilities. The conversation endpoint requires an LLM
 * and is only enabled when a runner (or runner source) is provided; without
 * one the endpoint reports 501 explicitly rather than pretending to work.
 * Passing a function makes the capability dynamic (admin hot-reconfiguration).
 *
 * `admin` serves GET /admin + /v1/admin/*; `chat` serves GET /chat +
 * /v1/host/* — both use the same page + data-handler + token shape.
 */
export interface AgentServiceOptions {
  conversationRunner?: ConversationRunner | (() => ConversationRunner | undefined);
  admin?: AdminOptions;
  chat?: AdminOptions;
}

export interface RunningAgentService {
  server: Server;
  address: AddressInfo;
}

export function parseAgentServiceConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgentServiceConfig {
  const host = env.ELYSIAN_AGENT_HOST ?? DEFAULT_AGENT_SERVICE_HOST;
  if (host.trim().length === 0) {
    throw new Error("ELYSIAN_AGENT_HOST must be a non-empty string");
  }

  const rawPort = env.ELYSIAN_AGENT_PORT ?? String(DEFAULT_AGENT_SERVICE_PORT);
  if (!/^\d+$/.test(rawPort)) {
    throw new Error("ELYSIAN_AGENT_PORT must be an integer from 0 to 65535");
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("ELYSIAN_AGENT_PORT must be an integer from 0 to 65535");
  }

  return { host, port };
}

/**
 * Builds the Hono app backing the service.
 */
function buildApp(options: AgentServiceOptions = {}): Hono {
  const app = new Hono();

  const resolveRunner = (): ConversationRunner | undefined =>
    typeof options.conversationRunner === "function"
      ? options.conversationRunner()
      : options.conversationRunner;

  app.onError((error, c) => {
    return errorJson(c, 500, "AGENT_SERVICE_ERROR",
      error instanceof Error ? error.message : "unknown agent service error");
  });

  app.notFound((c) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      c.header("allow", "GET, HEAD");
      return errorJson(c, 405, "METHOD_NOT_ALLOWED", "method is not allowed");
    }
    return errorJson(c, 404, "NOT_FOUND", "route not found");
  });

  app.get("/healthz", (c) => c.json({ status: "ok", service: AGENT_SERVICE_NAME }));

  app.get("/readyz", (c) =>
    c.json({
      status: "ready",
      service: AGENT_SERVICE_NAME,
      capabilities: [
        "cognitive-loop",
        "memory",
        "affect",
        "reflection",
        "realm-agent-step.v1",
        ...(resolveRunner() ? ["realm-conversation.v1"] : []),
      ],
    }),
  );

  registerExtension(app, "/admin", "/v1/admin", options.admin, "admin");
  registerExtension(app, "/chat", "/v1/host", options.chat, "chat");

  app.all(
    "/v1/realm/steps",
    async (c) => {
      if (c.req.method !== "POST") {
        c.header("allow", "POST");
        return errorJson(c, 405, "METHOD_NOT_ALLOWED", "route requires POST");
      }

      const parsed = await readJsonBody(c);
      if (!parsed.ok) {
        return errorJson(c, parsed.status, parsed.code, parsed.message);
      }

      try {
        return c.json(executeRealmAgentStepV1(parsed.value));
      } catch (error) {
        if (error instanceof RealmAgentStepValidationError) {
          return errorJson(c, 400, "INVALID_REALM_AGENT_STEP", error.message);
        }
        throw error;
      }
    },
  );

  app.all(
    "/v1/realm/conversations",
    async (c) => {
      if (c.req.method !== "POST") {
        c.header("allow", "POST");
        return errorJson(c, 405, "METHOD_NOT_ALLOWED", "route requires POST");
      }

      const runner = resolveRunner();
      if (!runner) {
        return errorJson(
          c,
          501,
          "CONVERSATION_NOT_CONFIGURED",
          "this service instance was started without a conversation runner",
        );
      }

      const parsed = await readJsonBody(c);
      if (!parsed.ok) {
        return errorJson(c, parsed.status, parsed.code, parsed.message);
      }

      try {
        return c.json(await executeRealmConversationV1(parsed.value, runner));
      } catch (error) {
        if (error instanceof RealmConversationValidationError) {
          return errorJson(c, 400, "INVALID_REALM_CONVERSATION", error.message);
        }
        throw error;
      }
    },
  );

  return app;
}

export function createAgentService(options: AgentServiceOptions = {}): Server {
  return createAdaptorServer({ fetch: buildApp(options).fetch }) as Server;
}

export async function startAgentService(
  config: AgentServiceConfig,
  options: AgentServiceOptions = {},
): Promise<RunningAgentService> {
  const server = createAgentService(options);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await stopAgentService(server);
    throw new Error("agent service started without a TCP address");
  }

  return { server, address };
}

export async function stopAgentService(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function registerExtension(
  app: Hono,
  pagePath: string,
  apiPrefix: string,
  extension: AdminOptions | undefined,
  name: string,
): void {
  const gate = (c: Context): Response | undefined => {
    if (extension === undefined) {
      return errorJson(
        c,
        404,
        `${name.toUpperCase()}_NOT_ENABLED`,
        `${name} interface is not enabled on this service instance`,
      );
    }
    if (
      extension.token !== undefined &&
      !hasValidAdminToken(c.req.header("authorization"), extension.token)
    ) {
      return errorJson(
        c,
        403,
        `${name.toUpperCase()}_FORBIDDEN`,
        `missing or invalid ${name} token`,
      );
    }
    return undefined;
  };

  app.all(pagePath, async (c) => {
    const gateResult = gate(c);
    if (gateResult !== undefined) {
      return gateResult;
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      c.header("allow", "GET, HEAD");
      return errorJson(c, 405, "METHOD_NOT_ALLOWED", "route requires GET");
    }
    if (extension!.page === undefined) {
      return errorJson(
        c,
        404,
        `${name.toUpperCase()}_PAGE_NOT_CONFIGURED`,
        `no ${name} page configured`,
      );
    }
    c.header("cache-control", "no-store");
    return c.html(extension!.page);
  });

  app.all(`${apiPrefix}/*`, async (c) => {
    // The bare prefix (no trailing slash) is not an extension route; fall
    // through to the service-level 404/405 handling like the old matcher.
    if (c.req.path === apiPrefix) {
      return c.notFound();
    }

    const gateResult = gate(c);
    if (gateResult !== undefined) {
      return gateResult;
    }

    let body: unknown;
    if (c.req.method === "POST" || c.req.method === "PUT") {
      const parsed = await readJsonBody(c);
      if (!parsed.ok) {
        // Allow empty bodies for extension POSTs (e.g. test with current config).
        if (parsed.code === "INVALID_JSON" && parsed.message.includes("must contain JSON")) {
          body = undefined;
        } else {
          return errorJson(c, parsed.status, parsed.code, parsed.message);
        }
      } else {
        body = parsed.value;
      }
    }

    const result = await extension!.handler(c.req.method, c.req.path, body);
    if (result === undefined) {
      return errorJson(c, 404, "NOT_FOUND", `${name} route not found`);
    }
    if ("stream" in result) {
      c.header("cache-control", "no-store");
      return streamSSE(c, async (stream) => {
        // Emits arrive synchronously; chain writes so frames keep order.
        let queued: Promise<void> = Promise.resolve();
        const emit = (event: string, data: unknown): void => {
          queued = queued.then(() => stream.writeSSE({ event, data: JSON.stringify(data) }));
        };
        await result.stream(emit);
        await queued;
      });
    }
    return c.json(result.body, result.status as ContentfulStatusCode);
  });
}

function errorJson(
  c: Context,
  status: number,
  code: string,
  message: string,
): Response {
  return c.json({ error: { code, message } }, status as ContentfulStatusCode);
}

function hasValidAdminToken(header: string | undefined, token: string): boolean {
  if (typeof header !== "string") {
    return false;
  }
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) {
    return false;
  }
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readJsonBody(
  c: Context,
): Promise<
  | { ok: true; value: unknown }
  | { ok: false; status: number; code: string; message: string }
> {
  const rawBody = c.req.raw.body;
  if (rawBody) {
    const read = await streamBodyText(rawBody, MAX_BODY_BYTES);
    if (!read.ok) {
      return {
        ok: false,
        status: 413,
        code: "REQUEST_TOO_LARGE",
        message: "request body exceeds 1 MiB",
      };
    }
    if (read.text.length > 0) {
      try {
        return { ok: true, value: JSON.parse(read.text) };
      } catch {
        return {
          ok: false,
          status: 400,
          code: "INVALID_JSON",
          message: "request body must be valid JSON",
        };
      }
    }
  }
  return {
    ok: false,
    status: 400,
    code: "INVALID_JSON",
    message: "request body must contain JSON",
  };
}

/**
 * Streams the request body to a string, stopping at maxBytes (same drain
 * semantics as the previous hand-rolled node:http reader: the upload is
 * consumed up to the cap so the client sees a clean 413 response).
 */
async function streamBodyText(
  rawBody: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const reader = rawBody.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}
