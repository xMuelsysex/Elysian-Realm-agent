import test from "node:test";
import assert from "node:assert/strict";

import {
  CONVERSATION_MEMORY_IMPORTANCE,
  MAX_CONVERSATION_AFFINITY_DELTA,
  buildConversationSystemPrompt,
  createConversationRunner,
  describeAffinity,
  describeEmotion,
  parseAffectAnalysis,
  runAffectAnalysis,
  type ConversationReplyInput,
  type LlmPort,
} from "@elysian/simulation-agent";
import {
  REALM_CONVERSATION_SCHEMA_VERSION,
  type RealmConversationRequestV1,
} from "@elysian/simulation-agent/service";

const NOW = "2026-07-26T12:00:00.000Z";

function conversationRequest(
  overrides: Partial<RealmConversationRequestV1> = {},
): RealmConversationRequestV1 {
  return {
    schemaVersion: REALM_CONVERSATION_SCHEMA_VERSION,
    conversationId: "conv_1",
    now: NOW,
    agent: {
      agentId: "agent_elysia",
      personaId: "elysia",
      displayName: "Elysia",
      persona: "A cheerful, curious resident of the Elysian Realm.",
    },
    participant: { participantId: "user_muelsyse", displayName: "Muelsyse" },
    memories: [
      {
        id: "memory_1",
        agentId: "agent_elysia",
        kind: "conversation",
        content: "Muelsyse promised to visit the flower garden together.",
        createdAt: "2026-07-25T09:00:00.000Z",
        lastAccessedAt: "2026-07-25T09:00:00.000Z",
        importance: 6,
        sourceIds: ["user_muelsyse"],
        relatedMemoryIds: [],
        visibility: "private",
        tags: ["conversation", "agent_elysia", "user_muelsyse", "garden"],
        metadata: { source: "conversation", conversationId: "conv_0" },
      },
    ],
    relationship: {
      agentId: "agent_elysia",
      targetId: "user_muelsyse",
      affinity: 42,
      updatedAt: "2026-07-25T09:00:00.000Z",
    },
    mood: { agentId: "agent_elysia", mood: "cheerful", intensity: 0.7, updatedAt: NOW },
    history: [
      { role: "participant", content: "Hi Elysia!" },
      { role: "agent", content: "Hello! Lovely day, right?" },
    ],
    message: { messageId: "msg_9", content: "Shall we go to the garden today?" },
    ...overrides,
  };
}

function fakeAnalysisLlm(reply: string): { llm: LlmPort; requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    llm: {
      name: "fake-analysis",
      model: "fake",
      completeChat(request) {
        requests.push(request.messages.map((message) => message.content).join("\n---\n"));
        return Promise.resolve({ content: reply });
      },
    },
  };
}

test("describeAffinity maps values onto deterministic bands", () => {
  assert.equal(describeAffinity(80), "devoted");
  assert.equal(describeAffinity(42), "close");
  assert.equal(describeAffinity(20), "friendly");
  assert.equal(describeAffinity(0), "neutral");
  assert.equal(describeAffinity(-20), "wary");
  assert.equal(describeAffinity(-50), "hostile");
  assert.equal(describeAffinity(-90), "resentful");
});

test("system prompt carries persona, affect state, and retrieved memories", () => {
  const prompt = buildConversationSystemPrompt({
    agent: conversationRequest().agent,
    participant: conversationRequest().participant,
    relationship: conversationRequest().relationship,
    mood: conversationRequest().mood,
    memoryHits: [
      {
        record: conversationRequest().memories[0],
        score: { relevance: 1, recency: 1, importance: 0.6, finalScore: 0.9 },
      },
    ],
  });

  assert.match(prompt, /You are Elysia \(persona elysia\)/);
  assert.match(prompt, /cheerful, curious resident/);
  assert.match(prompt, /Current mood: cheerful \(intensity 0\.70 of 1\)/);
  assert.match(prompt, /Relationship with Muelsyse: close \(affinity 42/);
  assert.match(prompt, /\[conversation\] Muelsyse promised to visit the flower garden/);
  assert.match(prompt, /in the language the participant is using/);
});

test("system prompt states missing affect and memories explicitly", () => {
  const prompt = buildConversationSystemPrompt({
    agent: conversationRequest().agent,
    participant: conversationRequest().participant,
    memoryHits: [],
  });

  assert.match(prompt, /Current mood: unremarkable\./);
  assert.match(prompt, /no established relationship yet/);
  assert.match(prompt, /none retrieved/);
});

test("describeEmotion maps signatures onto quadrant labels with modifiers", () => {
  assert.equal(describeEmotion({ valence: 0.8, arousal: 0.6 }), "strongly joyful and energized");
  assert.equal(describeEmotion({ valence: 0.5, arousal: 0.2 }), "warm and content");
  assert.equal(describeEmotion({ valence: -0.6, arousal: 0.7 }), "tense and unsettled");
  assert.equal(describeEmotion({ valence: -0.3, arousal: 0.1 }), "heavy and low");
  assert.equal(describeEmotion({ valence: 0.1, arousal: 0.9 }), "alert and stirred");
  assert.equal(describeEmotion({ valence: 0.0, arousal: 0.3 }), "calm and neutral");
});

test("system prompt renders the emotional signature of retrieved memories", () => {
  const request = conversationRequest();
  const emotional = {
    ...request.memories[0],
    emotion: { valence: 0.8, arousal: 0.6 },
  };
  const prompt = buildConversationSystemPrompt({
    agent: request.agent,
    participant: request.participant,
    memoryHits: [
      {
        record: emotional,
        score: { relevance: 1, recency: 1, importance: 0.6, finalScore: 0.9 },
      },
    ],
  });

  assert.match(
    prompt,
    /\[conversation\] Muelsyse promised to visit the flower garden together\. — at the time you felt strongly joyful and energized/,
  );
});

test("system prompt omits emotional phrasing for memories without a signature", () => {
  const request = conversationRequest();
  const prompt = buildConversationSystemPrompt({
    agent: request.agent,
    participant: request.participant,
    memoryHits: [
      {
        record: request.memories[0],
        score: { relevance: 1, recency: 1, importance: 0.6, finalScore: 0.9 },
      },
    ],
  });

  assert.doesNotMatch(prompt, /at the time you felt/);
});

test("parseAffectAnalysis accepts strict JSON and code-fenced JSON", () => {
  const plain = parseAffectAnalysis(
    '{"affinityDelta": 3, "mood": "warm", "moodIntensity": 0.6, "reason": "friendly plan"}',
  );
  assert.equal(plain.analysis, "llm");
  assert.equal(plain.affinityDelta, 3);
  assert.deepEqual(plain.mood, { mood: "warm", intensity: 0.6 });
  assert.equal(plain.reason, "friendly plan");

  const fenced = parseAffectAnalysis(
    '```json\n{"affinityDelta": -2, "mood": "hurt", "moodIntensity": 0.4}\n```',
  );
  assert.equal(fenced.analysis, "llm");
  assert.equal(fenced.affinityDelta, -2);
});

test("parseAffectAnalysis repairs truncated LLM JSON before extracting fields", () => {
  // Model stopped mid-object (missing closing brace). jsonrepair closes it.
  const truncated = parseAffectAnalysis(
    '{"affinityDelta": 2, "mood": "warm", "moodIntensity": 0.7',
  );
  assert.equal(truncated.analysis, "llm");
  assert.equal(truncated.affinityDelta, 2);
  assert.deepEqual(truncated.mood, { mood: "warm", intensity: 0.7 });
});

test("parseAffectAnalysis clamps out-of-bound values and notes it in the reason", () => {
  const result = parseAffectAnalysis(
    '{"affinityDelta": 55, "mood": "elated", "moodIntensity": 3, "reason": "big moment"}',
  );
  assert.equal(result.analysis, "llm");
  assert.equal(result.affinityDelta, MAX_CONVERSATION_AFFINITY_DELTA);
  assert.equal(result.mood?.intensity, 1);
  assert.match(result.reason, /clamped from 55/);
  assert.match(result.reason, /clamped from 3/);
});

test("parseAffectAnalysis parses and clamps emotion signatures", () => {
  const result = parseAffectAnalysis(
    '{"affinityDelta": 1, "mood": "moved", "moodIntensity": 0.6, "emotion": {"valence": 0.8, "arousal": 0.6}, "reason": "kind words"}',
  );
  assert.equal(result.analysis, "llm");
  assert.deepEqual(result.emotion, { valence: 0.8, arousal: 0.6 });

  const clamped = parseAffectAnalysis(
    '{"affinityDelta": 1, "mood": "overwhelmed", "moodIntensity": 0.6, "emotion": {"valence": 2, "arousal": -1}, "reason": "intense"}',
  );
  assert.deepEqual(clamped.emotion, { valence: 1, arousal: 0 });
  assert.match(clamped.reason, /emotion\.valence clamped from 2/);
  assert.match(clamped.reason, /emotion\.arousal clamped from -1/);
});

test("parseAffectAnalysis ignores unusable emotion values without failing the analysis", () => {
  const nonNumeric = parseAffectAnalysis(
    '{"affinityDelta": 1, "mood": "fine", "moodIntensity": 0.5, "emotion": {"valence": "happy", "arousal": 0.5}, "reason": "x"}',
  );
  assert.equal(nonNumeric.analysis, "llm");
  assert.equal(nonNumeric.emotion, undefined);
  assert.match(nonNumeric.reason, /ignored emotion/);

  const nonObject = parseAffectAnalysis(
    '{"affinityDelta": 1, "mood": "fine", "moodIntensity": 0.5, "emotion": "thrilled", "reason": "x"}',
  );
  assert.equal(nonObject.analysis, "llm");
  assert.equal(nonObject.emotion, undefined);
});

test("parseAffectAnalysis fails visibly on garbage and on empty analyses", () => {
  const garbage = parseAffectAnalysis("sure! here is my analysis...");
  assert.equal(garbage.analysis, "failed");
  assert.match(garbage.reason, /non-JSON/);

  const empty = parseAffectAnalysis('{"reason": "nothing changed"}');
  assert.equal(empty.analysis, "failed");
  assert.match(empty.reason, /neither/);

  const nonObject = parseAffectAnalysis("[1, 2]");
  assert.equal(nonObject.analysis, "failed");
});

test("runAffectAnalysis surfaces llm request failures as failed analysis", async () => {
  const llm: LlmPort = {
    name: "broken",
    model: "broken",
    completeChat() {
      return Promise.reject(new Error("provider unreachable"));
    },
  };
  const result = await runAffectAnalysis(llm, {
    agentDisplayName: "Elysia",
    participantDisplayName: "Muelsyse",
    turns: [{ role: "participant", content: "hello" }],
  });
  assert.equal(result.analysis, "failed");
  assert.match(result.reason, /provider unreachable/);
});

test("runner retrieves memories into the prompt and returns reply, affect, and memory writes", async () => {
  const replyInputs: ConversationReplyInput[] = [];
  const analysis = fakeAnalysisLlm(
    '{"affinityDelta": 2, "mood": "delighted", "moodIntensity": 0.8, "reason": "garden plan agreed"}',
  );
  const runner = createConversationRunner({
    reply: {
      generateReply(input) {
        replyInputs.push(input);
        return Promise.resolve({ content: "Yes! Meet me by the fountain." });
      },
    },
    analysisLlm: analysis.llm,
  });

  const request = conversationRequest();
  const response = await runner.run(request);

  assert.equal(replyInputs.length, 1);
  assert.equal(replyInputs[0].conversationId, "conv_1");
  assert.equal(replyInputs[0].message, request.message.content);
  assert.deepEqual(replyInputs[0].history, request.history);
  assert.match(replyInputs[0].systemPrompt, /flower garden/);

  assert.equal(response.schemaVersion, REALM_CONVERSATION_SCHEMA_VERSION);
  assert.equal(response.agentId, "agent_elysia");
  assert.equal(response.reply.content, "Yes! Meet me by the fountain.");
  assert.equal(response.affect.analysis, "llm");
  assert.equal(response.affect.affinityDelta, 2);
  assert.deepEqual(response.affect.mood, { mood: "delighted", intensity: 0.8 });

  assert.equal(analysis.requests.length, 1);
  assert.match(analysis.requests[0], /Muelsyse: Shall we go to the garden today\?/);
  assert.match(analysis.requests[0], /Elysia: Yes! Meet me by the fountain\./);

  assert.equal(response.memoryWrites.length, 2);
  const [incoming, reply] = response.memoryWrites;
  assert.equal(incoming.kind, "conversation");
  assert.equal(incoming.importance, CONVERSATION_MEMORY_IMPORTANCE);
  assert.equal(incoming.content, "Muelsyse: Shall we go to the garden today?");
  assert.deepEqual(incoming.sourceIds, ["user_muelsyse"]);
  assert.equal(incoming.metadata?.source, "conversation");
  assert.equal(incoming.metadata?.messageRole, "incoming");
  assert.equal(incoming.metadata?.messageId, "msg_9");
  assert.equal(reply.metadata?.messageRole, "response");
  assert.equal(reply.metadata?.messageId, "msg_9:reply");
  assert.equal(reply.content, "Elysia: Yes! Meet me by the fountain.");
});

test("runner stamps the analysis emotion onto conversation memory writes", async () => {
  const runner = createConversationRunner({
    reply: { generateReply: () => Promise.resolve({ content: "That touched me." }) },
    analysisLlm: fakeAnalysisLlm(
      '{"affinityDelta": 3, "mood": "moved", "moodIntensity": 0.8, "memoryImportance": 6, "emotion": {"valence": 0.9, "arousal": 0.5}, "reason": "heartfelt"}',
    ).llm,
  });

  const response = await runner.run(conversationRequest());
  assert.deepEqual(response.affect.emotion, { valence: 0.9, arousal: 0.5 });
  assert.equal(response.memoryWrites.length, 2);
  for (const write of response.memoryWrites) {
    assert.deepEqual(write.emotion, { valence: 0.9, arousal: 0.5 });
  }
});

test("runner leaves memory writes emotion-free when analysis omits emotion", async () => {
  const runner = createConversationRunner({
    reply: { generateReply: () => Promise.resolve({ content: "ok" }) },
    analysisLlm: fakeAnalysisLlm(
      '{"affinityDelta": 1, "mood": "fine", "moodIntensity": 0.5, "reason": "plain"}',
    ).llm,
  });

  const response = await runner.run(conversationRequest());
  assert.equal(response.affect.emotion, undefined);
  for (const write of response.memoryWrites) {
    assert.equal(write.emotion, undefined);
  }
});

test("runner reports skipped analysis when no analysis llm is configured", async () => {
  const runner = createConversationRunner({
    reply: { generateReply: () => Promise.resolve({ content: "ok" }) },
  });
  const response = await runner.run(conversationRequest());
  assert.equal(response.affect.analysis, "skipped");
  assert.match(response.affect.reason, /no affect analysis llm configured/);
});

test("runner propagates reply failures instead of fabricating a reply", async () => {
  const runner = createConversationRunner({
    reply: { generateReply: () => Promise.reject(new Error("reply model down")) },
  });
  await assert.rejects(runner.run(conversationRequest()), /reply model down/);
});
