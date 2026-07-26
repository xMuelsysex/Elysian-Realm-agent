// Persisted LLM runtime configuration for the conversation track.
//
// Two modes share one shape:
//   catalog mode — `provider` set: model resolved from the pi-ai catalog.
//   custom mode  — `baseUrl` set: any OpenAI- or Anthropic-compatible
//                  endpoint (relays/proxies); model id is free-form.
// Exactly one of `provider` / `baseUrl` must be present.
//
// Written by the admin endpoint, read at service startup. Stored with mode
// 0600 (owner-only), same security class as ~/.aws or ~/.pi credentials.
// Writes go through a temp file + rename so a crash never leaves a half-
// written credentials file.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CUSTOM_LLM_APIS = ["openai-completions", "anthropic-messages"] as const;

export type CustomLlmApi = (typeof CUSTOM_LLM_APIS)[number];

export interface StoredLlmConfig {
  model: string;
  apiKey?: string;
  /** Catalog mode: a pi-ai built-in provider id. */
  provider?: string;
  /** Custom mode: base URL of an OpenAI/Anthropic-compatible endpoint. */
  baseUrl?: string;
  /** Custom mode only; defaults to "openai-completions". */
  api?: CustomLlmApi;
}

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

export function defaultLlmConfigPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return env.ELYSIAN_CREDENTIALS_PATH ?? join(homedir(), ".elysian-realm", "credentials.json");
}

/** Returns undefined when the file does not exist; throws on unreadable content. */
export function loadLlmConfig(path: string): StoredLlmConfig | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new LlmConfigError(
      `cannot read llm credentials file ${path}: ${(error as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LlmConfigError(`llm credentials file ${path} is not valid JSON`);
  }
  return validateLlmConfig(parsed);
}

export function saveLlmConfig(path: string, config: StoredLlmConfig): void {
  const validated = validateLlmConfig(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, path);
  // rename preserves the temp file's 0600; enforce it even if an older file
  // with looser permissions was replaced on a platform that keeps the target's.
  chmodSync(path, 0o600);
}

/** Single validation authority, shared by file load/save and the admin API. */
export function validateLlmConfig(input: unknown): StoredLlmConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new LlmConfigError("llm config must be a JSON object");
  }
  const record = input as Record<string, unknown>;

  if (typeof record.model !== "string" || record.model.trim().length === 0) {
    throw new LlmConfigError("llm config: model must be a non-empty string");
  }
  if (
    record.apiKey !== undefined &&
    (typeof record.apiKey !== "string" || record.apiKey.trim().length === 0)
  ) {
    throw new LlmConfigError("llm config: apiKey must be a non-empty string when present");
  }

  const hasProvider = record.provider !== undefined;
  const hasBaseUrl = record.baseUrl !== undefined;
  if (hasProvider === hasBaseUrl) {
    throw new LlmConfigError(
      "llm config: exactly one of provider (catalog mode) or baseUrl (custom relay mode) must be set",
    );
  }

  if (hasProvider) {
    if (typeof record.provider !== "string" || record.provider.trim().length === 0) {
      throw new LlmConfigError("llm config: provider must be a non-empty string");
    }
    if (record.api !== undefined) {
      throw new LlmConfigError("llm config: api is only valid in custom relay mode (with baseUrl)");
    }
    return {
      provider: record.provider,
      model: record.model,
      ...(record.apiKey !== undefined ? { apiKey: record.apiKey as string } : {}),
    };
  }

  if (typeof record.baseUrl !== "string" || !isHttpUrl(record.baseUrl)) {
    throw new LlmConfigError("llm config: baseUrl must be a valid http(s) URL");
  }
  if (
    record.api !== undefined &&
    !(CUSTOM_LLM_APIS as readonly string[]).includes(record.api as string)
  ) {
    throw new LlmConfigError(`llm config: api must be one of ${CUSTOM_LLM_APIS.join(", ")}`);
  }

  return {
    baseUrl: record.baseUrl,
    model: record.model,
    ...(record.api !== undefined ? { api: record.api as CustomLlmApi } : {}),
    ...(record.apiKey !== undefined ? { apiKey: record.apiKey as string } : {}),
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
