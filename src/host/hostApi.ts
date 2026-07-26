// Host API: the /v1/host/* data routes behind the chat page, in the same
// pure-data handler shape the admin extension uses.

import type { AdminRequestHandler, AdminRequestResult } from "../service/agentService.js";
import type { RealmHost } from "./realmHost.js";

const HISTORY_PREFIX = "/v1/host/history/";

export function createHostApiHandler(host: RealmHost): AdminRequestHandler {
  return async (method, path, body): Promise<AdminRequestResult | undefined> => {
    if (path === "/v1/host/state" && method === "GET") {
      return { status: 200, body: { user: host.user(), agents: host.listAgents() } };
    }

    if (path.startsWith(HISTORY_PREFIX) && method === "GET") {
      const agentId = decodeURIComponent(path.slice(HISTORY_PREFIX.length));
      try {
        return { status: 200, body: { agentId, turns: host.history(agentId) } };
      } catch (error) {
        return badRequest(errorText(error));
      }
    }

    if (path === "/v1/host/chat" && method === "POST") {
      if (typeof body !== "object" || body === null) {
        return badRequest("request body must be a JSON object");
      }
      const record = body as Record<string, unknown>;
      if (typeof record.agentId !== "string" || typeof record.content !== "string") {
        return badRequest("agentId and content are required strings");
      }
      try {
        const result = await host.chat(record.agentId, record.content);
        return { status: 200, body: result };
      } catch (error) {
        // Chat failures (no LLM configured, empty message, provider errors)
        // surface as explicit 400s with the reason.
        return badRequest(errorText(error));
      }
    }

    return undefined;
  };
}

function badRequest(message: string): AdminRequestResult {
  return { status: 400, body: { error: { code: "INVALID_HOST_REQUEST", message } } };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
