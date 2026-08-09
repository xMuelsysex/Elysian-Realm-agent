// Tolerant JSON parsing for LLM output seams (affect analysis, reflection).
//
// Strict JSON.parse first (zero overhead on well-formed output); when that
// fails, content that looks JSON-shaped (starts with { or [) is repaired with
// jsonrepair — the standard library for LLM JSON corruption (truncation,
// missing commas, unquoted keys, unterminated strings) — and parsed again.
// Prose that does not look like JSON falls through unchanged so callers can
// report it as non-JSON.

import { jsonrepair } from "jsonrepair";

export function parseLlmJson(
  content: string,
): { ok: true; value: unknown } | { ok: false } {
  const trimmed = stripCodeFence(content);
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // strict parse failed; try repair below
  }

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { ok: false };
  }

  try {
    return { ok: true, value: JSON.parse(jsonrepair(trimmed)) };
  } catch {
    return { ok: false };
  }
}

/** Strips a single ```json ... ``` fence (or bare ``` fence) around LLM output. */
export function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}
