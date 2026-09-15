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
const PROFILE_HISTORY_PREFIX = "/v1/host/profile-history/";

export function createHostApiHandler(host: RealmHost): AdminRequestHandler {
  return async (method, path, body): Promise<AdminRequestResult | undefined> => {
    if (path === "/v1/host/profiles" && method === "GET") {
      return { status: 200, body: { profiles: host.listProfiles() } };
    }

    const stateProfileId = path.startsWith("/v1/host/state/")
      ? decodePathSegment(path.slice("/v1/host/state/".length), "profileId")
      : undefined;
    if (stateProfileId !== undefined && method === "GET") {
      if (typeof stateProfileId !== "string") return stateProfileId;
      return {
        status: 200,
        body: {
          user: host.user(stateProfileId),
          agents: host.listAgents(stateProfileId),
          story: host.storyProgress(stateProfileId),
        },
      };
    }
    if (path === "/v1/host/state" && method === "GET") {
      return {
        status: 200,
        body: { user: host.user(), agents: host.listAgents(), story: host.storyProgress() },
      };
    }

    if (path === "/v1/host/story-overview" && method === "POST") {
      if (!isRecord(body)) {
        return badRequest("request body must be a JSON object");
      }
      if (typeof body.agentId !== "string" || body.agentId.trim().length === 0) {
        return badRequest("agentId is a required non-empty string");
      }
      const profileId = optionalProfileId(body.profileId);
      if (profileId.error !== undefined) return badRequest(profileId.error);
      try {
        return {
          status: 200,
          body: await host.storyOverview(body.agentId, profileId.value),
        };
      } catch (error) {
        return unavailable(errorText(error));
      }
    }

    const statsProfileId = path.startsWith("/v1/host/stats/")
      ? decodePathSegment(path.slice("/v1/host/stats/".length), "profileId")
      : undefined;
    if (statsProfileId !== undefined && method === "GET") {
      if (typeof statsProfileId !== "string") return statsProfileId;
      try {
        return { status: 200, body: host.stats(statsProfileId) };
      } catch (error) {
        return badRequest(errorText(error));
      }
    }
    if (path === "/v1/host/stats" && method === "GET") {
      return { status: 200, body: host.stats() };
    }

    if (method === "GET" && (path.startsWith(HISTORY_PREFIX) || path.startsWith(PROFILE_HISTORY_PREFIX))) {
      const prefix = path.startsWith(PROFILE_HISTORY_PREFIX) ? PROFILE_HISTORY_PREFIX : HISTORY_PREFIX;
      const segments = path.slice(prefix.length).split("/");
      if (segments.length === 2) {
        const profileId = decodePathSegment(segments[0], "profileId");
        const agentId = decodePathSegment(segments[1], "agentId");
        if (typeof profileId !== "string") return profileId;
        if (typeof agentId !== "string") return agentId;
        try {
          return { status: 200, body: { agentId, profileId, turns: host.history(agentId, 50, profileId) } };
        } catch (error) {
          return badRequest(errorText(error));
        }
      }
      if (segments.length !== 1) return badRequest("profileId and agentId are required");
      const agentId = decodePathSegment(segments[0], "agentId");
      if (typeof agentId !== "string") return agentId;
      try {
        return { status: 200, body: { agentId, turns: host.history(agentId) } };
      } catch (error) {
        return badRequest(errorText(error));
      }
    }

    if (path === "/v1/host/new-conversation" && method === "POST") {
      if (!isRecord(body)) {
        return badRequest("request body must be a JSON object");
      }
      if (typeof body.agentId !== "string" || body.agentId.trim().length === 0) {
        return badRequest("agentId is a required non-empty string");
      }
      const profileId = optionalProfileId(body.profileId);
      if (profileId.error !== undefined) return badRequest(profileId.error);
      try {
        const cleared = host.newConversation(body.agentId, profileId.value);
        return { status: 200, body: { agentId: body.agentId, profileId: profileId.value, cleared } };
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
      const profileId = optionalProfileId(record.profileId);
      if (profileId.error !== undefined) return badRequest(profileId.error);
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
                profileId.value,
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
        const result = await host.chat(agentId, content, profileId.value);
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
      const profileId = optionalProfileId(record.profileId);
      if (profileId.error !== undefined) return badRequest(profileId.error);
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
        const affect = host.plotEvent(record.agentId, { type, target, intensity }, profileId.value);
        return { status: 200, body: { agentId: record.agentId, profileId: profileId.value, affect } };
      } catch (error) {
        return badRequest(errorText(error));
      }
    }

    return undefined;
  };
}

/** Realm profiles, story controls and read-only state for the admin dashboard. */
export function createHostAdminApiHandler(host: RealmHost): AdminRequestHandler {
  return async (method, path, body) => {
    if (path === "/v1/admin/profiles" && method === "GET") {
      return { status: 200, body: { profiles: host.listProfiles() } };
    }
    if (path === "/v1/admin/profiles" && method === "POST") {
      if (!isRecord(body)) return badRequest("request body must be a JSON object");
      if (typeof body.profileId !== "string" || typeof body.displayName !== "string") {
        return badRequest("profileId and displayName are required strings");
      }
      if (body.profile !== undefined && typeof body.profile !== "string") {
        return badRequest("profile must be a string");
      }
      try {
        return {
          status: 201,
          body: {
            profile: host.createProfile({
              profileId: body.profileId,
              displayName: body.displayName,
              ...(body.profile !== undefined ? { profile: body.profile } : {}),
            }),
          },
        };
      } catch (error) {
        return badRequest(errorText(error));
      }
    }

    const profileMatch = /^\/v1\/admin\/profiles\/([^/]+)$/.exec(path);
    if (profileMatch !== null && method === "PUT") {
      const profileId = decodePathSegment(profileMatch[1], "profileId");
      if (typeof profileId !== "string") return profileId;
      if (!isRecord(body) || typeof body.displayName !== "string") {
        return badRequest("displayName is a required string");
      }
      if (body.profile !== undefined && typeof body.profile !== "string") {
        return badRequest("profile must be a string");
      }
      try {
        return {
          status: 200,
          body: {
            profile: host.updateProfile(profileId, {
              displayName: body.displayName,
              ...(body.profile !== undefined ? { profile: body.profile } : {}),
            }),
          },
        };
      } catch (error) {
        return badRequest(errorText(error));
      }
    }

    const storyMatch = /^\/v1\/admin\/profiles\/([^/]+)\/story$/.exec(path);
    if (storyMatch !== null && method === "POST") {
      const profileId = decodePathSegment(storyMatch[1], "profileId");
      if (typeof profileId !== "string") return profileId;
      if (!isRecord(body) || typeof body.cursor !== "number" || !Number.isInteger(body.cursor)) {
        return badRequest("cursor is a required integer");
      }
      try {
        return { status: 200, body: { story: host.setStoryCursor(profileId, body.cursor) } };
      } catch (error) {
        return badRequest(errorText(error));
      }
    }

    const realmMatch = /^\/v1\/admin\/realm(?:\/([^/]+))?$/.exec(path);
    if (realmMatch !== null && method === "GET") {
      const profileId = realmMatch[1] === undefined
        ? undefined
        : decodePathSegment(realmMatch[1], "profileId");
      if (typeof profileId !== "string" && profileId !== undefined) return profileId;
      try {
        return {
          status: 200,
          body: {
            profile: host.user(profileId),
            story: host.storyProgress(profileId),
            agents: host.adminView(profileId),
          },
        };
      } catch (error) {
        return badRequest(errorText(error));
      }
    }
    return undefined;
  };
}

function optionalProfileId(input: unknown): { value?: string; error?: string } {
  if (input === undefined) return {};
  if (typeof input !== "string" || input.trim().length === 0) {
    return { error: "profileId must be a non-empty string" };
  }
  return { value: input };
}

function decodePathSegment(input: string, field: string): string | AdminRequestResult {
  try {
    const value = decodeURIComponent(input);
    return value.length > 0 ? value : badRequest(`${field} must be non-empty`);
  } catch {
    return badRequest(`${field} must be valid percent-encoding`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function badRequest(message: string): AdminRequestResult {
  return { status: 400, body: { error: { code: "INVALID_HOST_REQUEST", message } } };
}

function unavailable(message: string): AdminRequestResult {
  return { status: 503, body: { error: { code: "STORY_OVERVIEW_UNAVAILABLE", message } } };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
