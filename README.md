# Elysian Realm Agent

Independent home for the Elysian Realm simulation-agent cognitive core and its service process.

## Architecture: two tracks, one reality

The package now serves two cooperating tracks:

- **Tick track** — the deterministic cognitive loop (perceive, retrieve, plan, act, remember, reflect) resolved in batches via `realm-agent-step.v1`. Plans come from deterministic routines; no LLM is involved.
- **Conversation track** — stateless single-turn conversations via `realm-conversation.v1`, driven by `@earendil-works/pi-agent-core` for reply generation and an `LlmPort` for post-conversation affect analysis.

Both tracks meet in host-owned shared state: the memory stream and the affect snapshots (relationship affinity, agent mood). Conversation replies see tick-era memories and current affinity; later ticks retrieve conversation memories. The service only ever returns proposals (actions, memory writes, affect deltas); the host stays authoritative and applies them.

## Repository boundary

This repository owns:

- cognitive-loop orchestration and deterministic diagnostics;
- generic ports (`PerceptionPort`, `MemoryPort`, `PlanningPort`, `ActionSink`, `LlmPort`);
- in-memory memory records, validation, and retrieval scoring;
- affect state: per-relationship affinity and per-agent mood snapshots with bounded, observable mutations;
- reflection contracts, evidence validation, and explicit reflection execution;
- conversation domain logic: prompt assembly, affect analysis parsing, and the conversation runner;
- `SimulationAgentRuntime`, a thin facade over the canonical primitives;
- a Node HTTP service with health, readiness, step, and conversation endpoints;
- adapters for the pi stack, isolated behind dedicated subpaths.

Host applications continue to own authoritative world state, action application, provider configuration and API keys, production persistence, scheduling policy, budgets, and cancellation.

## Dependencies

- Node `>=22.19.0`.
- `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`, pinned exactly to `0.82.1` (`save-exact` is enforced via `.npmrc`). Upgrade deliberately against the upstream changelog's Breaking Changes sections.
- The package root entrypoint stays free of pi imports; pi code is reachable only through the `./llm/pi-ai` and `./conversation/pi` subpaths, so the core loop remains host-independent and offline-testable.

## Install and verify

```bash
npm install
npm test
npm run typecheck
npm run build
```

The tests are offline and deterministic, including the conversation track (fake stream functions at the two LLM seams) and a dual-track integration test that closes the memory/affect loop end to end.

## Start the service

```bash
npm run build
npm start
```

Configuration:

- `ELYSIAN_AGENT_HOST`, default `127.0.0.1`
- `ELYSIAN_AGENT_PORT`, default `4318`
- `ELYSIAN_LLM_PROVIDER` + `ELYSIAN_LLM_MODEL` (optional, set together): enable the conversation endpoint by selecting a model from the pi-ai catalog, e.g. `anthropic` + `claude-sonnet-4-6`. Credentials use the provider's standard variable (e.g. `ANTHROPIC_API_KEY`), resolved by pi-ai at request time. An unknown provider/model fails at startup.

Endpoints:

- `GET /healthz` reports process health.
- `GET /readyz` reports loaded cognitive capabilities.
- `GET /admin` serves a web UI for LLM configuration (see below).
- `POST /v1/realm/steps` resolves a versioned batch of agent routine ticks, memory writes, and bounded reflections.
- `POST /v1/realm/conversations` resolves one stateless conversation turn: reply text, a proposed affinity delta and mood, and proposed conversation memory writes.

### Configuring the conversation LLM

Three ways, in priority order:

1. **Environment variables** — `ELYSIAN_LLM_PROVIDER` + `ELYSIAN_LLM_MODEL` (auth via the provider's standard variable). When set, the selection is pinned and the admin UI rejects changes.
2. **Admin web UI** — open `http://127.0.0.1:4318/admin`. Two access modes: **custom relay** (default; paste any OpenAI- or Anthropic-compatible base URL — relays/proxies/one-api — plus a free-form model name and key) or the **pi-ai catalog** (pick from built-in providers/models). Test the connection, save, and the configuration hot-loads (no restart), persisting to `~/.elysian-realm/credentials.json` (mode 0600, override with `ELYSIAN_CREDENTIALS_PATH`). Stored keys are never echoed back by the API.
3. **Embedding** — assemble a runner in code (see below) for full control.

Admin security boundary: the admin interface is enabled as-is only for loopback binds. Binding to a non-loopback host requires `ELYSIAN_ADMIN_TOKEN` (sent as `Authorization: Bearer <token>`); without it the admin interface stays off and the service says so at startup.

The conversation endpoint requires an LLM. Without any configuration it reports `501 CONVERSATION_NOT_CONFIGURED` explicitly. Embedders can also assemble the runner directly for full control:

```ts
import { createConversationRunner } from "@elysian/simulation-agent";
import { startAgentService } from "@elysian/simulation-agent/service";
import { createPiConversationReplyPort } from "@elysian/simulation-agent/conversation/pi";
import { createPiAiLlmPort } from "@elysian/simulation-agent/llm/pi-ai";

// Host-owned provider setup (auth, model choice) via pi-ai:
//   const models = ...; const model = models.getModel(provider, id)!;
const runner = createConversationRunner({
  reply: createPiConversationReplyPort({ streamFn: models.streamSimple.bind(models), model }),
  analysisLlm: createPiAiLlmPort(models, model),
});
await startAgentService({ host: "127.0.0.1", port: 4318 }, { conversationRunner: runner });
```

## Core package usage

Use the public package entrypoint:

```ts
import {
  InMemoryAffectStore,
  InMemoryMemoryStore,
  SimulationAgentRuntime,
  createConversationRunner,
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
