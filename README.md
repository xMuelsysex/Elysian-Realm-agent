# Elysian Realm Agent

Independent home for the Elysian Realm simulation-agent cognitive core and its service process.

## Phase-one boundary

This repository owns:

- cognitive-loop orchestration: perceive, retrieve, plan, act, remember, and visible reflection diagnostics;
- generic ports and deterministic diagnostics;
- in-memory memory records, validation, and retrieval scoring;
- reflection contracts, evidence validation, and explicit reflection execution;
- `SimulationAgentRuntime`, a thin facade over the canonical primitives;
- a dependency-free Node HTTP service skeleton with health and readiness endpoints.

Host applications continue to own authoritative world state, action application, provider configuration, production persistence, scheduling policy, budgets, secrets, and cancellation.

## Install and verify

```bash
npm install
npm test
npm run typecheck
npm run build
```

The tests are offline and deterministic. They cover the migrated cognitive loop, memory, reflection, runtime facade, testing helpers, public package API, and service boundary.

## Start the service

```bash
npm run build
npm start
```

Configuration:

- `ELYSIAN_AGENT_HOST`, default `127.0.0.1`
- `ELYSIAN_AGENT_PORT`, default `4318`

Endpoints:

- `GET /healthz` reports process health.
- `GET /readyz` reports loaded cognitive capabilities.
- `POST /v1/realm/steps` resolves a versioned batch of agent routine ticks, memory writes, and bounded reflections.

The `realm-agent-step.v1` contract is exported from `@elysian/simulation-agent/service`. A batch request covers every agent in one simulation step, so the host can await cognition and then commit world mutations atomically. The service returns proposals, diagnostics, and complete per-agent memory streams; the host remains authoritative for world state and event application.

## Core package usage

Use the public package entrypoint:

```ts
import {
  InMemoryMemoryStore,
  SimulationAgentRuntime,
  runCognitiveTick,
} from "@elysian/simulation-agent";
```

Use the service entrypoint for embedding or service tests:

```ts
import {
  createAgentService,
  startAgentService,
} from "@elysian/simulation-agent/service";
```

Package internals remain host-independent. Imports from an Elysian Realm application source tree belong in host-side adapter layers.
