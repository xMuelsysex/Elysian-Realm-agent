import test from "node:test";
import assert from "node:assert/strict";

import type { ConversationRunner } from "@elysian/simulation-agent";
import {
  AgentServiceClient,
  AgentServiceClientError,
  REALM_CONVERSATION_SCHEMA_VERSION,
  startAgentService,
  stopAgentService,
  type RealmConversationRequestV1,
  type RealmConversationResponseV1,
} from "@elysian/simulation-agent/service";

const NOW = "2026-07-26T12:00:00.000Z";

function conversationRequest(): RealmConversationRequestV1 {
  return {
    schemaVersion: REALM_CONVERSATION_SCHEMA_VERSION,
    conversationId: "conv_http_1",
    now: NOW,
    agent: {
      agentId: "agent_elysia",
      personaId: "elysia",
      displayName: "Elysia",
      persona: "A cheerful resident.",
    },
    participant: { participantId: "user_muelsyse", displayName: "Muelsyse" },
    memories: [],
    history: [],
    message: { messageId: "msg_1", content: "Hello!" },
  };
}

function fakeRunner(): { runner: ConversationRunner; requests: RealmConversationRequestV1[] } {
  const requests: RealmConversationRequestV1[] = [];
  return {
    requests,
    runner: {
      run(request): Promise<RealmConversationResponseV1> {
        requests.push(request);
        return Promise.resolve({
          schemaVersion: REALM_CONVERSATION_SCHEMA_VERSION,
          conversationId: request.conversationId,
          agentId: request.agent.agentId,
          reply: { content: "Hi Muelsyse!" },
          affect: { analysis: "skipped", reason: "test" },
          memoryWrites: [],
        });
      },
    },
  };
}

test("conversation endpoint resolves a request through the injected runner", async () => {
  const { runner, requests } = fakeRunner();
  const running = await startAgentService({ host: "127.0.0.1", port: 0 }, { conversationRunner: runner });
  try {
    const client = new AgentServiceClient({
      baseUrl: `http://127.0.0.1:${running.address.port}`,
    });
    const response = await client.resolveConversation(conversationRequest());

    assert.equal(response.reply.content, "Hi Muelsyse!");
    assert.equal(response.conversationId, "conv_http_1");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].agent.agentId, "agent_elysia");

    const ready = await fetch(`http://127.0.0.1:${running.address.port}/readyz`);
    const readyBody = (await ready.json()) as { capabilities: string[] };
    assert.ok(readyBody.capabilities.includes("realm-conversation.v1"));
    assert.ok(readyBody.capabilities.includes("affect"));
  } finally {
    await stopAgentService(running.server);
  }
});

test("conversation endpoint returns 400 for invalid requests without invoking the runner", async () => {
  const { runner, requests } = fakeRunner();
  const running = await startAgentService({ host: "127.0.0.1", port: 0 }, { conversationRunner: runner });
  try {
    const client = new AgentServiceClient({
      baseUrl: `http://127.0.0.1:${running.address.port}`,
    });
    const invalid = { ...conversationRequest(), schemaVersion: "bogus" };
    await assert.rejects(
      client.resolveConversation(invalid as unknown as RealmConversationRequestV1),
      (error: unknown) => {
        assert.ok(error instanceof AgentServiceClientError);
        assert.equal(error.code, "INVALID_REALM_CONVERSATION");
        assert.equal(error.status, 400);
        return true;
      },
    );
    assert.equal(requests.length, 0);
  } finally {
    await stopAgentService(running.server);
  }
});

test("conversation endpoint reports 501 when no runner is configured", async () => {
  const running = await startAgentService({ host: "127.0.0.1", port: 0 });
  try {
    const client = new AgentServiceClient({
      baseUrl: `http://127.0.0.1:${running.address.port}`,
    });
    await assert.rejects(
      client.resolveConversation(conversationRequest()),
      (error: unknown) => {
        assert.ok(error instanceof AgentServiceClientError);
        assert.equal(error.code, "CONVERSATION_NOT_CONFIGURED");
        assert.equal(error.status, 501);
        return true;
      },
    );

    const ready = await fetch(`http://127.0.0.1:${running.address.port}/readyz`);
    const readyBody = (await ready.json()) as { capabilities: string[] };
    assert.equal(readyBody.capabilities.includes("realm-conversation.v1"), false);
  } finally {
    await stopAgentService(running.server);
  }
});

test("conversation endpoint requires POST", async () => {
  const running = await startAgentService({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(
      `http://127.0.0.1:${running.address.port}/v1/realm/conversations`,
    );
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  } finally {
    await stopAgentService(running.server);
  }
});

test("runner failures surface as 500 with the agent service error envelope", async () => {
  const failingRunner: ConversationRunner = {
    run() {
      return Promise.reject(new Error("reply model down"));
    },
  };
  const running = await startAgentService({ host: "127.0.0.1", port: 0 }, { conversationRunner: failingRunner });
  try {
    const response = await fetch(
      `http://127.0.0.1:${running.address.port}/v1/realm/conversations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(conversationRequest()),
      },
    );
    assert.equal(response.status, 500);
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "AGENT_SERVICE_ERROR");
    assert.match(body.error.message, /reply model down/);
  } finally {
    await stopAgentService(running.server);
  }
});
