// Plot-driven affect integration: proves the plot events flow from the tick
// contract through the deterministic engine into host-owned state, and that
// the resulting affect snapshot shapes conversation prompts.
//
// Script:
//   1. The host feeds plot events into realm-agent-step.v1; the executor
//      returns an affect proposal (full new state + affinity delta).
//   2. The host applies the proposal to persisted state.
//   3. A conversation carried against the post-event affect snapshot injects
//      the emotional state and expression guidance into the system prompt.
//   4. The host API exposes a plot feed endpoint with visible validation.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyPlotEvents,
  createConversationRunner,
  createInitialAffectState,
  type ConversationReplyInput,
  type PlotEvent,
} from "@elysian/simulation-agent";
import {
  REALM_AGENT_STEP_SCHEMA_VERSION,
  REALM_CONVERSATION_SCHEMA_VERSION,
  RealmAgentStepValidationError,
  RealmConversationValidationError,
  executeRealmAgentStepV1,
  executeRealmConversationV1,
  type RealmAgentStepRequestV1,
  type RealmConversationRequestV1,
} from "@elysian/simulation-agent/service";
import { createHostApiHandler } from "../src/host/hostApi.js";
import { RealmHost } from "../src/host/realmHost.js";
import { RealmStateStore } from "../src/host/realmState.js";

const AGENT_ID = "agent_elysia";
const STEP_NOW = "2026-08-08T10:00:00.000Z";
const STEP_NEXT = "2026-08-08T11:00:00.000Z";

function plotEvent(overrides: Partial<PlotEvent> = {}): PlotEvent {
  return {
    id: "plot_1",
    type: "kind_act",
    target: "host",
    intensity: 1,
    at: STEP_NOW,
    ...overrides,
  };
}

function stepRequest(overrides: Record<string, unknown> = {}): RealmAgentStepRequestV1 {
  return {
    schemaVersion: REALM_AGENT_STEP_SCHEMA_VERSION,
    stepId: "step_1",
    now: STEP_NOW,
    agents: [
      {
        perception: {
          agentId: AGENT_ID,
          personaId: "elysia",
          displayName: "Elysia",
          status: "idle",
          locationId: "garden",
          period: "day",
          nearbyAgentIds: [],
        },
        memories: [],
        ...overrides,
      },
    ],
  };
}

test("tick turns hostile plot events into a deterministic affect proposal", () => {
  const response = executeRealmAgentStepV1(
    stepRequest({
      affectState: createInitialAffectState(AGENT_ID, STEP_NOW),
      plotEvents: [
        plotEvent({ id: "p1", type: "hostile_act" }),
        plotEvent({ id: "p2", type: "hostile_act" }),
        plotEvent({ id: "p3", type: "hostile_act" }),
        plotEvent({ id: "p4", type: "threat" }),
      ],
    }),
  );

  const output = response.agents[0];
  assert.ok(output.affectProposal);
  assert.equal(output.affectProposal.affect.agentId, AGENT_ID);
  assert.equal(output.affectProposal.affect.valence, -1);
  assert.ok(output.affectProposal.affect.emotionLabels.anger >= 0.6);
  assert.ok(output.affectProposal.affect.emotionLabels.fear >= 0.6);
  assert.equal(output.affectProposal.affinityDelta, -10);
});

test("tick without affect inputs carries no affect proposal", () => {
  const response = executeRealmAgentStepV1(stepRequest());
  assert.equal(response.agents[0].affectProposal, undefined);
});

test("tick rejects malformed plot events and affect states visibly", () => {
  assert.throws(
    () => executeRealmAgentStepV1(stepRequest({ plotEvents: [plotEvent({ type: "bogus" as never })] })),
    RealmAgentStepValidationError,
  );
  assert.throws(
    () => executeRealmAgentStepV1(stepRequest({ plotEvents: "not-an-array" })),
    RealmAgentStepValidationError,
  );
  assert.throws(
    () =>
      executeRealmAgentStepV1(
        stepRequest({ affectState: { ...createInitialAffectState(AGENT_ID, STEP_NOW), valence: 9 } }),
      ),
    RealmAgentStepValidationError,
  );
});

function conversationRequest(affect: ReturnType<typeof createInitialAffectState>): RealmConversationRequestV1 {
  return {
    schemaVersion: REALM_CONVERSATION_SCHEMA_VERSION,
    conversationId: "conv_1",
    now: STEP_NEXT,
    agent: {
      agentId: AGENT_ID,
      personaId: "elysia",
      displayName: "Elysia",
      persona: "A cheerful, curious resident of the Elysian Realm.",
    },
    participant: { participantId: "user_muelsyse", displayName: "Muelsyse" },
    memories: [],
    affect,
    history: [],
    message: { messageId: "msg_1", content: "Are you all right?" },
  };
}

test("conversation prompt carries the emotional state and expression guidance", async () => {
  const stirred = applyPlotEvents(
    createInitialAffectState(AGENT_ID, STEP_NOW),
    [plotEvent({ type: "threat" }), plotEvent({ id: "p2", type: "surprise" })],
    STEP_NEXT,
  );

  let capturedPrompt = "";
  const runner = createConversationRunner({
    reply: {
      async generateReply(input: ConversationReplyInput) {
        capturedPrompt = input.systemPrompt;
        return { content: "I'm fine — just a little on edge today." };
      },
    },
  });
  const response = await runner.run(conversationRequest(stirred));
  assert.equal(response.reply.content, "I'm fine — just a little on edge today.");

  // Arousal 0.3 + 0.35 + 0.25 = 0.9 -> stirred; fear 0.6 -> uneasy.
  assert.match(capturedPrompt, /Current emotional state: .*prominent feelings: fear \(0\.60\)/);
  assert.match(capturedPrompt, /highly stirred/);
  assert.match(capturedPrompt, /uneasy/);
});

test("conversation validation rejects affect snapshots from another agent", async () => {
  const request = conversationRequest(createInitialAffectState("someone_else", STEP_NOW));
  await assert.rejects(
    () =>
      executeRealmConversationV1(request, {
        run: async () => {
          throw new Error("unreachable");
        },
      }),
    RealmConversationValidationError,
  );
});

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "elysian-realm-plot-"));
}

test("host plot events move emotion and affinity, and persist across restarts", () => {
  const dir = tempDataDir();
  const store = new RealmStateStore(dir);
  let clock = new Date(2026, 7, 8, 9, 0);
  const host = new RealmHost(store, () => undefined, { now: () => clock });

  const after = host.plotEvent(AGENT_ID, { type: "hostile_act", target: "host" });
  assert.equal(after.valence, 0.2 - 0.35);
  assert.ok(after.emotionLabels.anger >= 0.6);
  assert.equal(store.relationship(AGENT_ID)?.affinity, -5);

  // A fresh store over the same directory sees the persisted state.
  const reopened = new RealmStateStore(dir);
  assert.deepEqual(reopened.affectState(AGENT_ID), after);
  assert.equal(reopened.relationship(AGENT_ID)?.affinity, -5);

  // A later tick carries the state through the step and applies the decayed
  // proposal: time passes, feelings settle toward the baseline.
  clock = new Date(2026, 7, 8, 13, 0);
  const report = host.tickIfPeriodChanged();
  assert.ok(report);
  const settled = store.affectState(AGENT_ID);
  assert.ok(settled);
  assert.ok(settled.valence > after.valence, "valence regresses toward the baseline");
  assert.ok(settled.emotionLabels.anger < after.emotionLabels.anger, "anger quiets over time");
});

test("host plot API accepts valid events and rejects invalid ones visibly", async () => {
  const store = new RealmStateStore(tempDataDir());
  const host = new RealmHost(store, () => undefined, {
    now: () => new Date(2026, 7, 8, 9, 0),
  });
  const handler = createHostApiHandler(host);

  const ok = await handler("POST", "/v1/host/plot", {
    agentId: AGENT_ID,
    type: "kind_act",
    target: "host",
  });
  assert.equal(ok?.status, 200);
  assert.ok(ok && "body" in ok && typeof ok.body === "object" && ok.body !== null);
  const body = ok && "body" in ok ? (ok.body as { affect: { valence: number } }) : undefined;
  assert.ok((body?.affect.valence ?? 0) > 0.2);

  const badType = await handler("POST", "/v1/host/plot", {
    agentId: AGENT_ID,
    type: "bogus",
    target: "host",
  });
  assert.equal(badType?.status, 400);

  const badIntensity = await handler("POST", "/v1/host/plot", {
    agentId: AGENT_ID,
    type: "kind_act",
    target: "host",
    intensity: 7,
  });
  assert.equal(badIntensity?.status, 400);
});
