import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { ConversationRunner } from "../conversation/conversationRunner.js";
import {
  RealmConversationValidationError,
  executeRealmConversationV1,
} from "./realmConversationExecutor.js";
import {
  RealmAgentStepValidationError,
  executeRealmAgentStepV1,
} from "./realmStepExecutor.js";

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
export interface AdminRequestResult {
  status: number;
  body: unknown;
}

export type AdminRequestHandler = (
  method: string,
  path: string,
  body: unknown,
) => Promise<AdminRequestResult | undefined>;

export interface AdminOptions {
  handler: AdminRequestHandler;
  /** HTML served at GET /admin. */
  page?: string;
  /**
   * Bearer token required for every admin route. The assembly point decides:
   * loopback binds may omit it; non-loopback binds must set one (main.ts
   * refuses to enable admin without it).
   */
  token?: string;
}

/**
 * Optional service capabilities. The conversation endpoint requires an LLM
 * and is only enabled when a runner (or runner source) is provided; without
 * one the endpoint reports 501 explicitly rather than pretending to work.
 * Passing a function makes the capability dynamic (admin hot-reconfiguration).
 */
export interface AgentServiceOptions {
  conversationRunner?: ConversationRunner | (() => ConversationRunner | undefined);
  admin?: AdminOptions;
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

export function createAgentService(options: AgentServiceOptions = {}): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, options).catch((error) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      writeJson(response, 500, {
        error: {
          code: "AGENT_SERVICE_ERROR",
          message: error instanceof Error ? error.message : "unknown agent service error",
        },
      }, false);
    });
  });
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

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: AgentServiceOptions,
): Promise<void> {
  const method = request.method ?? "GET";
  const path = parsePath(request.url);
  const resolveRunner = (): ConversationRunner | undefined =>
    typeof options.conversationRunner === "function"
      ? options.conversationRunner()
      : options.conversationRunner;
  if (path === undefined) {
    writeJson(response, 400, { error: { code: "INVALID_REQUEST_URL", message: "request URL is invalid" } }, method === "HEAD");
    return;
  }

  if ((method === "GET" || method === "HEAD") && path === "/healthz") {
    writeJson(response, 200, { status: "ok", service: AGENT_SERVICE_NAME }, method === "HEAD");
    return;
  }

  if ((method === "GET" || method === "HEAD") && path === "/readyz") {
    writeJson(response, 200, {
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
    }, method === "HEAD");
    return;
  }

  if (path === "/admin" || path.startsWith("/v1/admin/")) {
    await handleAdminRequest(request, response, method, path, options.admin);
    return;
  }

  if (path === "/v1/realm/steps") {
    if (method !== "POST") {
      response.setHeader("allow", "POST");
      writeJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "route requires POST" } }, false);
      return;
    }

    const parsed = await readJsonBody(request);
    if (!parsed.ok) {
      writeJson(response, parsed.status, { error: { code: parsed.code, message: parsed.message } }, false);
      return;
    }

    try {
      writeJson(response, 200, executeRealmAgentStepV1(parsed.value), false);
    } catch (error) {
      if (error instanceof RealmAgentStepValidationError) {
        writeJson(response, 400, { error: { code: "INVALID_REALM_AGENT_STEP", message: error.message } }, false);
        return;
      }
      throw error;
    }
    return;
  }

  if (path === "/v1/realm/conversations") {
    if (method !== "POST") {
      response.setHeader("allow", "POST");
      writeJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "route requires POST" } }, false);
      return;
    }

    const runner = resolveRunner();
    if (!runner) {
      writeJson(response, 501, {
        error: {
          code: "CONVERSATION_NOT_CONFIGURED",
          message: "this service instance was started without a conversation runner",
        },
      }, false);
      return;
    }

    const parsed = await readJsonBody(request);
    if (!parsed.ok) {
      writeJson(response, parsed.status, { error: { code: parsed.code, message: parsed.message } }, false);
      return;
    }

    try {
      writeJson(response, 200, await executeRealmConversationV1(parsed.value, runner), false);
    } catch (error) {
      if (error instanceof RealmConversationValidationError) {
        writeJson(response, 400, { error: { code: "INVALID_REALM_CONVERSATION", message: error.message } }, false);
        return;
      }
      throw error;
    }
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    writeJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "method is not allowed" } }, false);
    return;
  }

  writeJson(response, 404, { error: { code: "NOT_FOUND", message: "route not found" } }, method === "HEAD");
}

async function handleAdminRequest(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  path: string,
  admin: AdminOptions | undefined,
): Promise<void> {
  if (!admin) {
    writeJson(response, 404, { error: { code: "ADMIN_NOT_ENABLED", message: "admin interface is not enabled on this service instance" } }, method === "HEAD");
    return;
  }

  if (admin.token !== undefined && !hasValidAdminToken(request, admin.token)) {
    writeJson(response, 403, { error: { code: "ADMIN_FORBIDDEN", message: "missing or invalid admin token" } }, false);
    return;
  }

  if (path === "/admin") {
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      writeJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "route requires GET" } }, false);
      return;
    }
    if (admin.page === undefined) {
      writeJson(response, 404, { error: { code: "ADMIN_PAGE_NOT_CONFIGURED", message: "no admin page configured" } }, method === "HEAD");
      return;
    }
    const payload = admin.page;
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-length", Buffer.byteLength(payload));
    response.end(method === "HEAD" ? undefined : payload);
    return;
  }

  let body: unknown;
  if (method === "POST" || method === "PUT") {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) {
      // Allow empty bodies for admin POSTs (e.g. test with current config).
      if (parsed.code === "INVALID_JSON" && parsed.message.includes("must contain JSON")) {
        body = undefined;
      } else {
        writeJson(response, parsed.status, { error: { code: parsed.code, message: parsed.message } }, false);
        return;
      }
    } else {
      body = parsed.value;
    }
  }

  const result = await admin.handler(method, path, body);
  if (result === undefined) {
    writeJson(response, 404, { error: { code: "NOT_FOUND", message: "admin route not found" } }, false);
    return;
  }
  writeJson(response, result.status, result.body, false);
}

function hasValidAdminToken(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
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

async function readJsonBody(request: IncomingMessage): Promise<
  | { ok: true; value: unknown }
  | { ok: false; status: number; code: string; message: string }
> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      return { ok: false, status: 413, code: "REQUEST_TOO_LARGE", message: "request body exceeds 1 MiB" };
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return { ok: false, status: 400, code: "INVALID_JSON", message: "request body must contain JSON" };
  }

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, code: "INVALID_JSON", message: "request body must be valid JSON" };
  }
}

function parsePath(requestUrl: string | undefined): string | undefined {
  try {
    return new URL(requestUrl ?? "/", "http://localhost").pathname;
  } catch {
    return undefined;
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headOnly: boolean,
): void {
  const payload = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(payload));
  response.end(headOnly ? undefined : payload);
}
