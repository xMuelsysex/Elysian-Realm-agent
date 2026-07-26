// Persisted LLM runtime configuration for the conversation track.
//
// Written by the admin endpoint, read at service startup. Stored with mode
// 0600 (owner-only), same security class as ~/.aws or ~/.pi credentials.
// Writes go through a temp file + rename so a crash never leaves a half-
// written credentials file.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredLlmConfig {
  provider: string;
  model: string;
  /** Absent when the provider's standard environment variable supplies auth. */
  apiKey?: string;
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
  return validateStoredConfig(parsed, path);
}

export function saveLlmConfig(path: string, config: StoredLlmConfig): void {
  const validated = validateStoredConfig(config, path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, path);
  // rename preserves the temp file's 0600; enforce it even if an older file
  // with looser permissions was replaced on a platform that keeps the target's.
  chmodSync(path, 0o600);
}

function validateStoredConfig(input: unknown, path: string): StoredLlmConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new LlmConfigError(`llm credentials in ${path} must be a JSON object`);
  }
  const record = input as Record<string, unknown>;
  if (typeof record.provider !== "string" || record.provider.trim().length === 0) {
    throw new LlmConfigError(`llm credentials in ${path}: provider must be a non-empty string`);
  }
  if (typeof record.model !== "string" || record.model.trim().length === 0) {
    throw new LlmConfigError(`llm credentials in ${path}: model must be a non-empty string`);
  }
  if (
    record.apiKey !== undefined &&
    (typeof record.apiKey !== "string" || record.apiKey.trim().length === 0)
  ) {
    throw new LlmConfigError(`llm credentials in ${path}: apiKey must be a non-empty string when present`);
  }
  return {
    provider: record.provider,
    model: record.model,
    ...(record.apiKey !== undefined ? { apiKey: record.apiKey as string } : {}),
  };
}
