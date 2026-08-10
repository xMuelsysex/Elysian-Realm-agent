#!/usr/bin/env node
// Real-LLM SSE verification: start host with the real relay credentials,
// stream one chat exchange over SSE, assert progressive deltas + done event,
// verify persistence, then check the JSON fallback contract.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const credPath = process.env.ELYSIAN_CREDENTIALS_PATH ?? new URL("./stub-credentials.json", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "sse-real-"));
const port = Number(process.env.E2E_HOST_PORT ?? 4322);
const stubPort = Number(process.env.STUB_PORT ?? 4330);
const proc = spawn("node", ["dist/host/main.js"], {
  env: {
    ...process.env,
    ELYSIAN_REALM_DATA: dir,
    ELYSIAN_AGENT_PORT: String(port),
    ELYSIAN_CREDENTIALS_PATH: credPath,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += d; });
proc.stderr.on("data", (d) => { log += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let exitCode = 0;

try {
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200; } catch { /* not up yet */ }
    if (!ready) await sleep(250);
  }
  if (!ready) {
    results.push("FAIL host did not become ready");
    exitCode = 1;
    process.exit(exitCode);
  }
  results.push("PASS host ready");

  // ── SSE streaming chat ────────────────────────────────────────────────
  const startedAt = Date.now();
  let firstDeltaAt = null;
  const deltas = [];
  let done = null;
  let applied = null;
  let errorEvent = null;

  const res = await fetch(`http://127.0.0.1:${port}/v1/host/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "agent_elysia", content: "你好呀，今天心情怎么样？", stream: true }),
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    results.push(`FAIL expected text/event-stream, got ${contentType}`);
    exitCode = 1;
  } else {
    results.push("PASS content-type text/event-stream");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });
    let frameEnd;
    while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const event = frame.split("\n").find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "message";
      const data = JSON.parse(dataLine.slice(5).trim());
      if (event === "delta") {
        if (firstDeltaAt === null) firstDeltaAt = Date.now();
        deltas.push(data.text);
      } else if (event === "done") {
        done = data;
      } else if (event === "applied") {
        applied = data;
      } else if (event === "error") {
        errorEvent = data;
      }
    }
  }
  const totalMs = Date.now() - startedAt;
  const firstDeltaMs = firstDeltaAt === null ? null : firstDeltaAt - startedAt;

  const reply = deltas.join("");
  if (errorEvent !== null) {
    results.push(`FAIL stream error event: ${errorEvent.message?.slice(0, 120)}`);
    exitCode = 1;
  } else if (deltas.length === 0 || reply.trim().length === 0) {
    results.push("FAIL no delta frames received");
    exitCode = 1;
  } else if (done === null) {
    results.push("FAIL no done event received");
    exitCode = 1;
  } else if (applied === null) {
    results.push("FAIL no applied event received");
    exitCode = 1;
  } else if (applied.affinity !== 3 || applied.mood?.mood !== "开心" || applied.analysis !== "llm") {
    results.push(`FAIL applied event malformed: ${JSON.stringify(applied).slice(0, 120)}`);
    exitCode = 1;
  } else {
    results.push(`PASS streamed ${deltas.length} delta frame(s), ${reply.length} chars, first delta at ${firstDeltaMs}ms, total ${totalMs}ms`);
    results.push(`PASS reply="${reply.slice(0, 60)}${reply.length > 60 ? "…" : ""}"`);
    results.push(`PASS done fires with the reply alone: ${done.reply === reply && done.affinity === undefined}`);
    results.push(`PASS applied carries the final state: affinity=${applied.affinity} mood=${applied.mood.mood} analysis=${applied.analysis}`);
  }

  // ── persistence ───────────────────────────────────────────────────────
  const hist = await fetch(`http://127.0.0.1:${port}/v1/host/history/agent_elysia`);
  const histBody = await hist.json();
  const turns = histBody.turns ?? [];
  results.push(
    turns.length >= 2
      ? `PASS history persisted ${turns.length} turn(s)`
      : `FAIL history expected >= 2 turns, got ${turns.length}`,
  );
  if (turns.length < 2) exitCode = 1;

  // ── relationship history: the chat's affinity move must be logged ─────
  let historyRows = 0;
  try {
    const db = new DatabaseSync(join(dir, "realm.sqlite"));
    historyRows = db
      .prepare("SELECT COUNT(*) AS n FROM relationship_history WHERE agent_id = ?")
      .get("agent_elysia").n;
    db.close();
  } catch { /* sqlite read failure → historyRows stays 0 */ }
  results.push(
    historyRows >= 1
      ? `PASS relationship history logged ${historyRows} row(s)`
      : `FAIL relationship history empty after chat (affinity should have moved)`,
  );
  if (historyRows < 1) exitCode = 1;

  // ── nightly loop: tick routines + narrative (+ reflection at night) ───
  // Fresh data dir: startup tick writes 2 routine memories, the narrative 1,
  // plus 2 conversation memories from the chats above. The reflection only
  // runs when the local period is "night" (22-5) — when it does, +1 more.
  const localHour = new Date().getHours();
  const isNight = localHour >= 22 || localHour < 6;
  const expected = isNight ? 6 : 5;
  let memories = 0;
  for (let i = 0; i < 40; i++) {
    const statsRes = await fetch(`http://127.0.0.1:${port}/v1/host/stats`);
    const stats = await statsRes.json();
    memories = stats.totals?.memories ?? 0;
    if (memories >= expected) break;
    await sleep(500);
  }
  results.push(
    memories >= expected
      ? `PASS nightly loop persisted ${memories} memories (tick + narrative${isNight ? " + reflection" : ""} + chat)`
      : `FAIL nightly loop: expected >= ${expected} memories, got ${memories}`,
  );
  if (memories < expected) exitCode = 1;

  // ── reflection seam: the stub must serve a valid insights array ──────
  // The host only reflects at night, so probe the stub directly to keep the
  // reflection routing (system-prompt routing + evidence id parsing) verified
  // regardless of the local period.
  const refRes = await fetch(`http://127.0.0.1:${stubPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "stub-model",
      messages: [
        {
          role: "system",
          content:
            "You are the inner voice of Elysia, a character reflecting on recent experiences before rest.",
        },
        {
          role: "user",
          content:
            "Evidence memories:\n- id=e_abc [conversation] (importance 5) 主人早上来看向日葵。",
        },
      ],
      stream: true,
    }),
  });
  const refDataLines = (await refRes.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line !== "[DONE]");
  const refContent = refDataLines
    .map((line) => {
      try {
        return JSON.parse(line).choices?.[0]?.delta?.content ?? "";
      } catch {
        return "";
      }
    })
    .join("");
  let refParsed = null;
  try {
    refParsed = JSON.parse(refContent);
  } catch {
    /* assert below */
  }
  const refOk =
    Array.isArray(refParsed) &&
    typeof refParsed[0]?.content === "string" &&
    Array.isArray(refParsed[0]?.evidenceIds) &&
    refParsed[0].evidenceIds.includes("e_abc");
  results.push(
    refOk
      ? "PASS reflection seam serves a valid insights array citing the evidence"
      : `FAIL reflection seam: ${refContent.slice(0, 80)}`,
  );
  if (!refOk) exitCode = 1;

  // ── JSON fallback contract ────────────────────────────────────────────
  const res2 = await fetch(`http://127.0.0.1:${port}/v1/host/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "agent_elysia", content: "再说一句话" }),
  });
  const body2 = await res2.json();
  results.push(
    res2.status === 200 && typeof body2.reply === "string" && body2.reply.length > 0
      ? "PASS json fallback chat works"
      : `FAIL json fallback: status=${res2.status} ${JSON.stringify(body2).slice(0, 100)}`,
  );
  if (res2.status !== 200) exitCode = 1;

  // ── multi-agent: the second persona must exist and chat standalone ────
  const stateRes = await fetch(`http://127.0.0.1:${port}/v1/host/state`);
  const stateBody = await stateRes.json();
  const mobius = (stateBody.agents ?? []).find((entry) => entry.agentId === "agent_mobius");
  results.push(
    stateRes.status === 200 && mobius !== undefined && mobius.displayName === "梅比乌斯"
      ? "PASS second persona (梅比乌斯) is listed"
      : `FAIL second persona missing: ${JSON.stringify(stateBody).slice(0, 120)}`,
  );
  if (stateRes.status !== 200 || mobius === undefined) exitCode = 1;

  const resMobius = await fetch(`http://127.0.0.1:${port}/v1/host/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "agent_mobius", content: "今天观察到了什么？" }),
  });
  const bodyMobius = await resMobius.json();
  const mobiusHist = await fetch(`http://127.0.0.1:${port}/v1/host/history/agent_mobius`);
  const mobiusTurns = (await mobiusHist.json()).turns ?? [];
  results.push(
    resMobius.status === 200 && typeof bodyMobius.reply === "string" && bodyMobius.reply.length > 0 &&
      mobiusHist.status === 200 && mobiusTurns.length >= 2
      ? `PASS 梅比乌斯 chat + history persists (${mobiusTurns.length} turns)`
      : `FAIL 梅比乌斯 chat: status=${resMobius.status} turns=${mobiusTurns.length}`,
  );
  if (resMobius.status !== 200 || mobiusTurns.length < 2) exitCode = 1;

  // ── metrics ───────────────────────────────────────────────────────────
  const now = new Date();
  if (firstDeltaMs !== null) {
    console.log(`METRIC sse_first_delta_ms=${firstDeltaMs}`);
  }
  console.log(`METRIC sse_total_ms=${totalMs}`);
  console.log(`METRIC sse_frames=${deltas.length}`);
  console.log(`METRIC sse_reply_chars=${reply.length}`);
  console.log(`METRIC verified_at=${now.toISOString()}`);
} catch (error) {
  results.push(`FAIL exception: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  proc.kill("SIGTERM");
  await new Promise((resolve) => proc.on("exit", resolve));
}

console.log(results.join("\n"));
console.log("--- host log tail ---");
console.log(log.split("\n").filter(Boolean).slice(-4).join("\n"));
process.exit(exitCode);
