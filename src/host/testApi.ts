// Read-only conversation inspection and local test routes for the /test page.
// The model status contains configuration metadata only; credentials never
// cross this boundary.

import type { ConversationHubStatus } from "../service/conversationBootstrap.js";
import type {
  AdminRequestHandler,
  AdminRequestResult,
} from "../service/agentService.js";
import type { RealmHost } from "./realmHost.js";

type TestConversationInput = {
  agentId: string;
  content: string;
  profileId?: string;
};

/** APIs used by the local story inspection page. */
export function createHostTestApiHandler(
  host: RealmHost,
  getModelStatus: () => ConversationHubStatus,
): AdminRequestHandler {
  return async (method, path, body): Promise<AdminRequestResult | undefined> => {
    if (path === "/v1/test/status" && method === "GET") {
      return {
        status: 200,
        body: {
          model: safeModelStatus(getModelStatus()),
          profiles: host.listProfiles(),
        },
      };
    }

    if ((path === "/v1/test/inspect" || path === "/v1/test/chat") && method === "POST") {
      const input = parseConversationInput(body);
      if (!input.ok) return badRequest(input.message);
      try {
        const inspection = host.inspectConversation(input.value.agentId, input.value.content, input.value.profileId);
        if (path === "/v1/test/inspect") {
          return {
            status: 200,
            body: { model: safeModelStatus(getModelStatus()), inspection },
          };
        }
        const result = await host.chat(input.value.agentId, input.value.content, input.value.profileId);
        return {
          status: 200,
          body: { model: safeModelStatus(getModelStatus()), inspection, result },
        };
      } catch (error) {
        return badRequest(errorText(error));
      }
    }

    return undefined;
  };
}

function safeModelStatus(status: ConversationHubStatus): ConversationHubStatus {
  return {
    configured: status.configured,
    ...(status.provider !== undefined ? { provider: status.provider } : {}),
    ...(status.model !== undefined ? { model: status.model } : {}),
    ...(status.baseUrl !== undefined ? { baseUrl: status.baseUrl } : {}),
    configSource: status.configSource,
    keySource: status.keySource,
  };
}

function parseConversationInput(body: unknown):
  | { ok: true; value: TestConversationInput }
  | { ok: false; message: string } {
  if (!isRecord(body)) {
    return { ok: false, message: "request body must be a JSON object" };
  }
  if (typeof body.agentId !== "string" || body.agentId.trim().length === 0) {
    return { ok: false, message: "agentId is a required non-empty string" };
  }
  if (typeof body.content !== "string" || body.content.trim().length === 0) {
    return { ok: false, message: "content is a required non-empty string" };
  }
  if (body.profileId !== undefined && (typeof body.profileId !== "string" || body.profileId.trim().length === 0)) {
    return { ok: false, message: "profileId must be a non-empty string" };
  }
  return {
    ok: true,
    value: {
      agentId: body.agentId,
      content: body.content,
      ...(body.profileId !== undefined ? { profileId: body.profileId } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function badRequest(message: string): AdminRequestResult {
  return { status: 400, body: { error: { code: "INVALID_TEST_REQUEST", message } } };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown test request error";
}
