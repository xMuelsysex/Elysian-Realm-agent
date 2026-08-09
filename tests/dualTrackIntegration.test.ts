// Dual-track integration: proves the tick track (realm-agent-step.v1) and the
// conversation track (realm-conversation.v1) close the loop through the shared
// memory stream and affect state that the host owns.
//
// Script:
//   1. Step N runs the deterministic tick and produces a plan memory.
//   2. The host applies a deterministic affect rule for the tick encounter.
//   3. A conversation is resolved against the post-step memories and affect
//      snapshot; the system prompt must reflect both tick memory and affinity.
//   4. The host applies the proposed conversation memory writes and affinity
//      delta.
//   5. Step N+1 retrieval sees the conversation memory, and the affect store
//      reflects the accumulated affinity — the two tracks share one reality.
//
// Only the two LLM seams are faked; every other component is real.

import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryAffectStore,
  InMemoryMemoryStore,
  createConversationRunner,
  type ConversationReplyInput,
  type LlmPort,
} from "@elysian/simulation-agent";
import {
  REALM_AGENT_STEP_SCHEMA_VERSION,
  REALM_CONVERSATION_SCHEMA_VERSION,
  executeRealmAgentStepV1,
  type RealmAgentStepRequestV1,
  type RealmMemoryMetadataV1,
  type RealmMemoryRecordV1,
} from "@elysian/simulation-agent/service";

const STEP_N_NOW = "2026-07-26T09:00:00.000Z";
const CONVERSATION_NOW = "2026-07-26T12:00:00.000Z";
const STEP_N1_NOW = "2026-07-26T15:00:00.000Z";

const AGENT_ID = "agent_elysia";
const PARTICIPANT_ID = "user_muelsyse";

function stepRequest(
  stepId: string,
  now: string,
  memories: readonly RealmMemoryRecordV1[],
): RealmAgentStepRequestV1 {
  return {
    schemaVersion: REALM_AGENT_STEP_SCHEMA_VERSION,
    stepId,
    now,
    agents: [
      {
        perception: {
          agentId: AGENT_ID,
          personaId: "elysia",
          displayName: "Elysia",
          status: "idle",
          locationId: "garden",
          period: "day",
          nearbyAgentIds: [PARTICIPANT_ID],
          activeRoutine: {
            personaId: "elysia",
            period: "day",
            index: 0,
            routineId: "elysia.day.0",
            planId: "elysia.day",
            locationId: "garden",
            intent: "Tend the flowers in the garden.",
          },
        },
        memories,
      },
    ],
  };
}

test("tick and conversation tracks close the loop through shared memory and affect", async () => {
  // Host-owned authoritative state.
  const affectStore = new InMemoryAffectStore();

  // 1. Step N: deterministic tick produces a routine proposal and a plan memory.
  const stepN = executeRealmAgentStepV1(stepRequest("step_0900", STEP_N_NOW, []));
  const stepNOutput = stepN.agents[0];
  assert.ok(stepNOutput.proposal, "step N must produce a routine proposal");
  assert.equal(stepNOutput.proposal?.locationId, "garden");
  const memoriesAfterStepN = stepNOutput.memories;
  assert.ok(
    memoriesAfterStepN.some((memory) => memory.kind === "plan"),
    "step N must record a plan memory",
  );

  // 2. Host rule: sharing a location during the tick nudges affinity up.
  const encounter = affectStore.applyAffinityDelta(AGENT_ID, PARTICIPANT_ID, 20, STEP_N_NOW);
  assert.equal(encounter.after.affinity, 20);

  // 3. Conversation against post-step memories and the affect snapshot.
  const replyInputs: ConversationReplyInput[] = [];
  const analysisLlm: LlmPort = {
    name: "fake-analysis",
    model: "fake",
    completeChat: () =>
      Promise.resolve({
        content:
          '{"affinityDelta": 4, "mood": "delighted", "moodIntensity": 0.8, "reason": "invited to the garden"}',
      }),
  };
  const runner = createConversationRunner({
    reply: {
      generateReply(input) {
        replyInputs.push(input);
        return Promise.resolve({ content: "I would love to show you the flowers!" });
      },
    },
    analysisLlm,
  });

  const conversation = await runner.run({
    schemaVersion: REALM_CONVERSATION_SCHEMA_VERSION,
    conversationId: "conv_noon",
    now: CONVERSATION_NOW,
    agent: {
      agentId: AGENT_ID,
      personaId: "elysia",
      displayName: "Elysia",
      persona: "A cheerful gardener of the Elysian Realm.",
    },
    participant: { participantId: PARTICIPANT_ID, displayName: "Muelsyse" },
    memories: memoriesAfterStepN,
    relationship: affectStore.getRelationship(AGENT_ID, PARTICIPANT_ID),
    mood: affectStore.getMood(AGENT_ID),
    history: [],
    message: { messageId: "msg_1", content: "Can you show me the garden flowers?" },
  });

  // The conversation prompt reflects the tick track: plan memory and affinity.
  const systemPrompt = replyInputs[0].systemPrompt;
  assert.match(systemPrompt, /garden/i, "tick-produced memory must reach the conversation prompt");
  assert.match(systemPrompt, /affinity 20/, "tick-era affinity must reach the conversation prompt");

  // 4. Host applies the proposed conversation outputs to its authoritative state.
  assert.equal(conversation.affect.analysis, "llm");
  assert.equal(conversation.affect.affinityDelta, 4);
  const updated = affectStore.applyAffinityDelta(
    AGENT_ID,
    PARTICIPANT_ID,
    conversation.affect.affinityDelta ?? 0,
    CONVERSATION_NOW,
  );
  assert.equal(updated.after.affinity, 24);
  if (conversation.affect.mood) {
    affectStore.setMood(AGENT_ID, conversation.affect.mood, CONVERSATION_NOW);
  }
  assert.equal(affectStore.getMood(AGENT_ID)?.mood, "delighted");

  const hostMemoryStore = new InMemoryMemoryStore<RealmMemoryMetadataV1>(memoriesAfterStepN);
  for (const write of conversation.memoryWrites) {
    hostMemoryStore.remember(AGENT_ID, write);
  }
  const memoriesAfterConversation = hostMemoryStore.list(AGENT_ID);
  assert.equal(
    memoriesAfterConversation.filter((memory) => memory.metadata.source === "conversation").length,
    2,
  );

  // 5. Step N+1: the tick track retrieves the conversation memory.
  const stepN1 = executeRealmAgentStepV1(
    stepRequest("step_1500", STEP_N1_NOW, memoriesAfterConversation),
  );
  const stepN1Output = stepN1.agents[0];
  const retrievePhase = stepN1Output.phases.find((phase) => phase.phase === "retrieve");
  assert.equal(retrievePhase?.status, "ran");

  const retrieval = hostMemoryStore.retrieve(AGENT_ID, {
    text: "garden flowers Muelsyse",
    now: STEP_N1_NOW,
    topK: 3,
  });
  assert.ok(
    retrieval.hits.some((hit) => hit.record.metadata.source === "conversation"),
    "step N+1 retrieval must surface the conversation memory",
  );

  // Affect accumulated across both tracks in one authoritative store.
  assert.equal(affectStore.getRelationship(AGENT_ID, PARTICIPANT_ID)?.affinity, 24);
});

test("emotional signatures survive the full loop into the next conversation prompt", async () => {
  // First exchange: the analysis stamps an emotion onto the proposed writes.
  const analysisLlm: LlmPort = {
    name: "fake-analysis",
    model: "fake",
    completeChat: () =>
      Promise.resolve({
        content:
          '{"affinityDelta": 3, "mood": "moved", "moodIntensity": 0.7, "memoryImportance": 7, "emotion": {"valence": 0.9, "arousal": 0.6}, "reason": "confession"}',
      }),
  };
  const runner = createConversationRunner({
    reply: { generateReply: () => Promise.resolve({ content: "I treasure every moment with you." }) },
    analysisLlm,
  });

  const baseRequest = {
    schemaVersion: REALM_CONVERSATION_SCHEMA_VERSION,
    conversationId: "conv_1",
    now: CONVERSATION_NOW,
    agent: {
      agentId: AGENT_ID,
      personaId: "elysia",
      displayName: "Elysia",
      persona: "A cheerful gardener of the Elysian Realm.",
    },
    participant: { participantId: PARTICIPANT_ID, displayName: "Muelsyse" },
    memories: [] as readonly RealmMemoryRecordV1[],
    history: [],
    message: { messageId: "msg_1", content: "You mean so much to me." },
  };
  const first = await runner.run(baseRequest);
  assert.deepEqual(first.affect.emotion, { valence: 0.9, arousal: 0.6 });

  // The host applies the writes; the emotion survives storage and retrieval.
  const hostMemoryStore = new InMemoryMemoryStore<RealmMemoryMetadataV1>();
  for (const write of first.memoryWrites) {
    hostMemoryStore.remember(AGENT_ID, write);
  }
  assert.deepEqual(hostMemoryStore.list(AGENT_ID)[0]?.emotion, { valence: 0.9, arousal: 0.6 });

  // Second exchange: retrieval surfaces the emotional memory into the prompt.
  const replyInputs: ConversationReplyInput[] = [];
  const secondRunner = createConversationRunner({
    reply: {
      generateReply(input) {
        replyInputs.push(input);
        return Promise.resolve({ content: "I remember." });
      },
    },
    analysisLlm: {
      name: "fake-analysis",
      model: "fake",
      completeChat: () =>
        Promise.resolve({
          content: '{"affinityDelta": 0, "mood": "warm", "moodIntensity": 0.6, "reason": "x"}',
        }),
    },
  });
  await secondRunner.run({
    ...baseRequest,
    conversationId: "conv_2",
    memories: hostMemoryStore.list(AGENT_ID),
    message: { messageId: "msg_2", content: "Do you remember what you said?" },
  });

  assert.match(
    replyInputs[0].systemPrompt,
    /at the time you felt strongly joyful and energized/,
    "the next conversation must recall how the agent felt back then",
  );
});
