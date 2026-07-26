import test from "node:test";
import assert from "node:assert/strict";

import {
  AgentServiceClient,
  AgentServiceClientError,
  DEFAULT_AGENT_SERVICE_HOST,
  DEFAULT_AGENT_SERVICE_PORT,
  REALM_AGENT_STEP_SCHEMA_VERSION,
  executeRealmAgentStepV1,
  parseAgentServiceConfig,
  startAgentService,
  stopAgentService,
  type RealmAgentStepRequestV1,
} from "@elysian/simulation-agent/service";

const NOW = "2026-05-31T12:00:00.000Z";
const STEP_ID = "step_1200_072";

function realmStepRequest(): RealmAgentStepRequestV1 {
  return {
    schemaVersion: REALM_AGENT_STEP_SCHEMA_VERSION,
    stepId: STEP_ID,
    now: NOW,
    agents: [
      {
        perception: {
          agentId: "agent_elysia",
          personaId: "elysia",
          displayName: "Elysia",
          status: "idle",
          locationId: "atrium",
          period: "day",
          currentActionId: "elysia.morning.0",
          nearbyAgentIds: [],
          activeRoutine: {
            personaId: "elysia",
            period: "day",
            index: 0,
            routineId: "elysia.day.0",
            planId: "elysia.day",
            locationId: "lounge",
            intent: "Spend time in the lounge.",
          },
        },
        memories: [
          {
            id: "memory_seed_agent_elysia",
            agentId: "agent_elysia",
            kind: "observation",
            content: "Elysia starts in the atrium with the configured morning routine.",
            createdAt: "2026-05-31T06:00:00.000Z",
            lastAccessedAt: "2026-05-31T06:00:00.000Z",
            importance: 5,
            sourceIds: ["seed:agent_elysia"],
            relatedMemoryIds: [],
            visibility: "system",
            tags: ["agent_elysia", "elysia", "atrium", "morning", "seed"],
            metadata: {
              stepId: "step_0600_000",
              source: "seed",
              period: "morning",
              locationId: "atrium",
            },
          },
        ],
      },
    ],
  };
}

test("service config uses deterministic local defaults", () => {
  assert.deepEqual(parseAgentServiceConfig({}), {
    host: DEFAULT_AGENT_SERVICE_HOST,
    port: DEFAULT_AGENT_SERVICE_PORT,
  });
});

test("service config accepts explicit host and port", () => {
  assert.deepEqual(
    parseAgentServiceConfig({
      ELYSIAN_AGENT_HOST: "0.0.0.0",
      ELYSIAN_AGENT_PORT: "5000",
    }),
    { host: "0.0.0.0", port: 5000 },
  );
});

test("service config rejects malformed host and port values visibly", () => {
  assert.throws(() => parseAgentServiceConfig({ ELYSIAN_AGENT_HOST: " " }), /ELYSIAN_AGENT_HOST/);
  assert.throws(() => parseAgentServiceConfig({ ELYSIAN_AGENT_PORT: "43x" }), /ELYSIAN_AGENT_PORT/);
  assert.throws(() => parseAgentServiceConfig({ ELYSIAN_AGENT_PORT: "65536" }), /ELYSIAN_AGENT_PORT/);
});

test("realm step executor owns routine planning memory and reflection", () => {
  const response = executeRealmAgentStepV1(realmStepRequest());
  const agent = response.agents[0];

  assert.equal(response.schemaVersion, REALM_AGENT_STEP_SCHEMA_VERSION);
  assert.equal(agent?.proposal?.id, "elysia.day.0");
  assert.equal(agent?.proposal?.locationId, "lounge");
  assert.equal(agent?.activeRoutine?.planId, "elysia.day");
  assert.deepEqual(agent?.phases.map((phase) => phase.phase), [
    "perceive",
    "retrieve",
    "plan",
    "act",
    "remember",
    "reflect",
  ]);
  assert.equal(agent?.memories.filter((memory) => memory.kind === "plan").length, 1);
  assert.equal(agent?.memories.filter((memory) => memory.kind === "reflection").length, 1);
  assert.equal(agent?.reflection.status, "completed");
  assert.equal(agent?.reflection.persistedMemoryIds.length, 1);
});

test("realm step executor rejects invalid versions and cross-agent memories", () => {
  assert.throws(
    () => executeRealmAgentStepV1({ ...realmStepRequest(), schemaVersion: "realm-agent-step.v2" }),
    /schemaVersion/,
  );

  const request = realmStepRequest();
  const memory = request.agents[0]!.memories[0]!;
  assert.throws(
    () => executeRealmAgentStepV1({
      ...request,
      agents: [{
        ...request.agents[0],
        memories: [{ ...memory, agentId: "agent_other" }],
      }],
    }),
    /must belong/,
  );
});

test("service exposes health readiness versioned execution and explicit HTTP failures", async (context) => {
  const running = await startAgentService({ host: "127.0.0.1", port: 0 });
  context.after(async () => {
    await stopAgentService(running.server);
  });

  const baseUrl = `http://127.0.0.1:${running.address.port}`;

  const healthResponse = await fetch(`${baseUrl}/healthz`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), {
    status: "ok",
    service: "elysian-realm-agent",
  });

  const readyResponse = await fetch(`${baseUrl}/readyz`);
  assert.equal(readyResponse.status, 200);
  assert.deepEqual(await readyResponse.json(), {
    status: "ready",
    service: "elysian-realm-agent",
    capabilities: ["cognitive-loop", "memory", "affect", "reflection", "realm-agent-step.v1"],
  });

  const client = new AgentServiceClient({ baseUrl });
  const resolved = await client.resolveRealmStep(realmStepRequest());
  assert.equal(resolved.agents[0]?.proposal?.id, "elysia.day.0");
  assert.equal(resolved.agents[0]?.reflection.status, "completed");

  const invalidResponse = await fetch(`${baseUrl}/v1/realm/steps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: "wrong" }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.deepEqual(await invalidResponse.json(), {
    error: {
      code: "INVALID_REALM_AGENT_STEP",
      message: `schemaVersion must be ${REALM_AGENT_STEP_SCHEMA_VERSION}`,
    },
  });

  const missingResponse = await fetch(`${baseUrl}/missing`);
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(await missingResponse.json(), {
    error: { code: "NOT_FOUND", message: "route not found" },
  });

  const methodResponse = await fetch(`${baseUrl}/healthz`, { method: "POST" });
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get("allow"), "GET, HEAD");
  assert.deepEqual(await methodResponse.json(), {
    error: { code: "METHOD_NOT_ALLOWED", message: "method is not allowed" },
  });
});

test("service client exposes structured service errors", async (context) => {
  const running = await startAgentService({ host: "127.0.0.1", port: 0 });
  context.after(async () => {
    await stopAgentService(running.server);
  });
  const client = new AgentServiceClient({
    baseUrl: `http://127.0.0.1:${running.address.port}`,
  });

  await assert.rejects(
    () => client.resolveRealmStep({ ...realmStepRequest(), agents: [] }),
    (error: unknown) => {
      assert.ok(error instanceof AgentServiceClientError);
      assert.equal(error.code, "INVALID_REALM_AGENT_STEP");
      assert.equal(error.status, 400);
      return true;
    },
  );
});
