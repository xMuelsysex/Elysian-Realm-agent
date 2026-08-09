// Host API: the /v1/host/* data routes behind the chat page, in the same
// pure-data handler shape the admin extension uses.

import type {
  AdminRequestHandler,
  AdminRequestResult,
  AdminStreamResult,
} from "../service/agentService.js";
import { PLOT_EVENT_TARGETS, PLOT_EVENT_TYPES } from "../affect/affectRecords.js";
import type { PlotEventTarget, PlotEventType } from "../affect/affectRecords.js";
import type { RealmHost } from "./realmHost.js";

const HISTORY_PREFIX = "/v1/host/history/";

export function createHostApiHandler(host: RealmHost): AdminRequestHandler {
  return async (method, path, body): Promise<AdminRequestResult | undefined> => {
    if (path === "/v1/host/state" && method === "GET") {
      return { status: 200, body: { user: host.user(), agents: host.listAgents() } };
    }

    if (path === "/v1/host/stats" && method === "GET") {
      return { status: 200, body: host.stats() };
    }

    if (path.startsWith(HISTORY_PREFIX) && method === "GET") {
      let agentId: string;
      try {
        agentId = decodeURIComponent(path.slice(HISTORY_PREFIX.length));
      } catch {
        // Malformed percent-encoding is a client error, not a server fault.
        return badRequest("agentId must be valid percent-encoding");
      }
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
      const agentId = record.agentId;
      const content = record.content;
      // Streaming mode: emit reply deltas as SSE frames, a "done" event the
      // moment the reply completes (so the page can unlock input), and an
      // "applied" event with the final state once analysis + persistence
      // finish. Errors mid-stream surface as an "error" event.
      if (record.stream === true) {
        return {
          status: 200,
          stream: async (emit) => {
            try {
              const result = await host.chatStream(
                agentId,
                content,
                (text) => {
                  emit("delta", { text });
                },
                (text) => {
                  emit("done", { agentId, reply: text });
                },
              );
              emit("applied", {
                agentId: result.agentId,
                reply: result.reply,
                affinity: result.affinity,
                mood: result.mood,
                analysis: result.analysis,
                analysisReason: result.analysisReason,
              });
            } catch (error) {
              emit("error", { message: errorText(error) });
            }
          },
        } satisfies AdminStreamResult;
      }
      try {
        const result = await host.chat(agentId, content);
        return { status: 200, body: result };
      } catch (error) {
        // Chat failures (no LLM configured, empty message, provider errors)
        // surface as explicit 400s with the reason.
        return badRequest(errorText(error));
      }
    }

    if (path === "/v1/host/plot" && method === "POST") {
      if (typeof body !== "object" || body === null) {
        return badRequest("request body must be a JSON object");
      }
      const record = body as Record<string, unknown>;
      if (typeof record.agentId !== "string" || record.agentId.trim().length === 0) {
        return badRequest("agentId is a required string");
      }
      if (
        typeof record.type !== "string" ||
        !PLOT_EVENT_TYPES.includes(record.type as PlotEventType)
      ) {
        return badRequest(`type must be one of: ${PLOT_EVENT_TYPES.join(", ")}`);
      }
      const type = record.type as PlotEventType;
      if (
        typeof record.target !== "string" ||
        !PLOT_EVENT_TARGETS.includes(record.target as PlotEventTarget)
      ) {
        return badRequest(`target must be one of: ${PLOT_EVENT_TARGETS.join(", ")}`);
      }
      const target = record.target as PlotEventTarget;
      let intensity = 1;
      if (record.intensity !== undefined) {
        if (
          typeof record.intensity !== "number" ||
          !Number.isFinite(record.intensity) ||
          record.intensity < 0 ||
          record.intensity > 1
        ) {
          return badRequest("intensity must be a number from 0 to 1");
        }
        intensity = record.intensity;
      }
      try {
        const affect = host.plotEvent(record.agentId, { type, target, intensity });
        return { status: 200, body: { agentId: record.agentId, affect } };
      } catch (error) {
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
