import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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

export function createAgentService(): Server {
  return createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
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

export async function startAgentService(config: AgentServiceConfig): Promise<RunningAgentService> {
  const server = createAgentService();

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

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const path = parsePath(request.url);
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
      capabilities: ["cognitive-loop", "memory", "reflection", "realm-agent-step.v1"],
    }, method === "HEAD");
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

  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    writeJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "method is not allowed" } }, false);
    return;
  }

  writeJson(response, 404, { error: { code: "NOT_FOUND", message: "route not found" } }, method === "HEAD");
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
