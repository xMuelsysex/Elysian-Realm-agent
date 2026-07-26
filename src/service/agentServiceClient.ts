import {
  REALM_AGENT_STEP_SCHEMA_VERSION,
  type AgentServiceErrorBody,
  type RealmAgentStepRequestV1,
  type RealmAgentStepResponseV1,
} from "./realmStepV1.js";

export interface AgentServiceClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class AgentServiceClientError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "AgentServiceClientError";
    this.code = code;
    this.status = status;
  }
}

export class AgentServiceClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AgentServiceClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new AgentServiceClientError("INVALID_CLIENT_CONFIG", "timeoutMs must be a positive integer");
    }
  }

  async resolveRealmStep(request: RealmAgentStepRequestV1): Promise<RealmAgentStepResponseV1> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/realm/steps`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const body = await parseJsonResponse(response);
      if (!response.ok) {
        const serviceError = parseServiceError(body);
        throw new AgentServiceClientError(
          serviceError?.error.code ?? "AGENT_SERVICE_HTTP_ERROR",
          serviceError?.error.message ?? `agent service returned HTTP ${response.status}`,
          response.status,
        );
      }
      return validateResponse(body, request.stepId);
    } catch (error) {
      if (error instanceof AgentServiceClientError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new AgentServiceClientError("AGENT_SERVICE_TIMEOUT", `agent service request exceeded ${this.timeoutMs}ms`);
      }
      throw new AgentServiceClientError(
        "AGENT_SERVICE_REQUEST_FAILED",
        error instanceof Error ? error.message : "agent service request failed",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    throw new AgentServiceClientError(
      "INVALID_AGENT_SERVICE_RESPONSE",
      "agent service response body must contain JSON",
      response.status,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AgentServiceClientError(
      "INVALID_AGENT_SERVICE_RESPONSE",
      "agent service response body must be valid JSON",
      response.status,
    );
  }
}

function validateResponse(input: unknown, expectedStepId: string): RealmAgentStepResponseV1 {
  if (!isRecord(input) || input.schemaVersion !== REALM_AGENT_STEP_SCHEMA_VERSION) {
    throw new AgentServiceClientError(
      "INVALID_AGENT_SERVICE_RESPONSE",
      `agent service response schemaVersion must be ${REALM_AGENT_STEP_SCHEMA_VERSION}`,
    );
  }
  if (input.stepId !== expectedStepId) {
    throw new AgentServiceClientError(
      "INVALID_AGENT_SERVICE_RESPONSE",
      "agent service response stepId does not match the request",
    );
  }
  if (!Array.isArray(input.agents)) {
    throw new AgentServiceClientError(
      "INVALID_AGENT_SERVICE_RESPONSE",
      "agent service response agents must be an array",
    );
  }
  return input as unknown as RealmAgentStepResponseV1;
}

function parseServiceError(input: unknown): AgentServiceErrorBody | undefined {
  if (!isRecord(input) || !isRecord(input.error)) return undefined;
  if (typeof input.error.code !== "string" || typeof input.error.message !== "string") return undefined;
  return input as unknown as AgentServiceErrorBody;
}

function normalizeBaseUrl(baseUrl: string): string {
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
    throw new AgentServiceClientError("INVALID_CLIENT_CONFIG", "baseUrl must be a non-empty URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new AgentServiceClientError("INVALID_CLIENT_CONFIG", "baseUrl must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AgentServiceClientError("INVALID_CLIENT_CONFIG", "baseUrl must use http or https");
  }
  return parsed.toString().replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
