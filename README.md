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
- `hono` + `@hono/node-server` (HTTP layer, zero transitive deps), `jsonrepair` (tolerant LLM JSON parsing), and the built-in `node:sqlite` (host persistence) back the service and host processes.
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
npm start        # stateless service: step + conversation + admin endpoints
npm run host     # stateful realm host: chat UI + persistence + tick scheduler
```

### Realm host (`npm run host`)

The host is the authoritative process that makes agents "live": it owns and persists world state under `./realm-data/` (`ELYSIAN_REALM_DATA` to override) — persona config (`realm.json`, hand-editable, seeded with a default persona on first run) plus a SQLite store (`realm.sqlite`, via the built-in `node:sqlite`) holding memory streams, affect snapshots, conversation histories, and tick state, with one transaction per mutation. Legacy full-snapshot JSON files (memories/affect/conversations/tick) are imported once on first open. It applies conversation proposals (memory writes, affinity deltas, moods) automatically, and runs a deterministic routine tick whenever the local wall-clock period changes (morning 6–11, day 11–17, evening 17–22, night otherwise), so agents accumulate a daily life between conversations.

`agents[].persona` accepts either a plain description string (legacy) or a **structured character contract** (recommended) with facets injected into conversation, life-narrative, and nightly-reflection prompts: `identity`, `personality`, `values`, `speechStyle`, `boundaries` (OOC red lines), `behaviorTraits`, and `exampleLines` (in-voice sample lines). A plain string is rendered as the legacy single `Persona:` section.

- `GET /chat` — chat UI with a live affinity/mood badge
- `GET /admin` — LLM configuration (same as the service)
- `GET /v1/host/state` — agent summaries with live affinity/mood/affect
- `GET /v1/host/stats` — non-destructive store counts + retention diagnostics (per-agent memories/turns, oldestMemoryAt, 90-day-unused staleMemories, SQLite bytes)
- `GET /v1/host/history/{agentId}` — conversation turns
- `POST /v1/host/chat` — one exchange; send `{"agentId", "content", "stream": true}` for SSE: `delta` frames (reply text), `done` (reply complete — UI unlocks), `applied` (final affinity/mood after analysis), `error` on failures; omit `stream` for the JSON response

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

### End-to-end verification (`npm run verify:e2e`)

Runs the full SSE streaming pipeline against a local OpenAI-compatible stub
(`tests/e2e/llm-stub.mjs`): pi-ai's HTTP streaming client, the text-delta
subscription, host persistence, and the JSON fallback contract. It verifies
the live code path that unit tests cannot (real stream parsing, event
ordering, first-delta latency). To verify against a real relay instead:

```bash
ELYSIAN_CREDENTIALS_PATH=~/.elysian-realm/credentials.json bash scripts/run-e2e.sh
```

## Known limitations

- `node:sqlite` is experimental before Node 25.7 (unflagged since 22.13); the store works on the declared `>=22.19` range but prints an experimental warning on older versions.
- Conversation history is stored without a retention cap — it grows with usage. `GET /v1/host/stats` reports per-agent memory/turn counts plus 90-day-unused prune candidates to inform a cleanup decision.
- Legacy pre-SQLite JSON files (`memories.json` etc.) are imported once and then left as stale artifacts; they can be deleted by hand after a successful start.
- Chat replies stream progressively (SSE); the affect analysis runs after the reply completes, so the badge may update a moment after the reply appears.
- Browser-level verification (Playwright) is manual — see `.claude/specs/host-runtime.md` for the process-management notes.
