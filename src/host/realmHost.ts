// Realm host orchestration: the authoritative process around the stateless
// cores. Chat requests flow persona/memory/affect state into the conversation
// runner and APPLY the returned proposals (memory writes, affinity delta,
// mood) to the persisted state — closing the loop the service contracts leave
// to the host. Ticks run the deterministic step when the real-clock period
// changes, so agents accumulate a daily life between conversations.
//
// No pi imports here: the runner arrives via its port interface.

import type { ConversationRunner } from "../conversation/conversationRunner.js";
import type { LlmPort } from "../ports/ports.js";
import {
  REALM_CONVERSATION_SCHEMA_VERSION,
  type RealmConversationTurnV1,
} from "../service/realmConversationV1.js";
import {
  REALM_AGENT_STEP_SCHEMA_VERSION,
  type RealmMemoryMetadataV1,
  type RealmRoutinePeriodV1,
} from "../service/realmStepV1.js";
import { executeRealmAgentStepV1 } from "../service/realmStepExecutor.js";
import { runReflection } from "../reflection/reflectionPlanner.js";
import { createLlmReflectionPlanner } from "../reflection/llmReflectionPlanner.js";
import type { AffectState, AgentMood, PlotEvent, PlotEventTarget, PlotEventType } from "../affect/affectRecords.js";
import {
  applyPlotEvents,
  computeAffinityDelta,
  createInitialAffectState,
} from "../affect/plotRules.js";
import type { RealmAffectProposalV1 } from "../service/realmStepV1.js";
import { runLifeNarrative } from "./lifeNarrative.js";
import { detectOocLeak } from "../conversation/oocGuard.js";
import type { RealmStateStore, RealmStoreStats } from "./realmState.js";

const CHAT_HISTORY_WINDOW = 20;
const NARRATIVE_CONTINUITY_WINDOW = 3;
const REFLECTION_EVIDENCE_LIMIT = 12;

export interface RealmChatResult {
  agentId: string;
  displayName: string;
  reply: string;
  affinity: number;
  mood?: AgentMood;
  /** Analysis outcome for visibility; "failed" keeps the reply usable. */
  analysis: string;
  analysisReason: string;
}

export interface RealmAgentSummary {
  agentId: string;
  displayName: string;
  personaId: string;
  affinity: number;
  mood?: AgentMood;
  affect?: AffectState;
  memoryCount: number;
}

export interface RealmHostOptions {
  /** Injectable clock for tests. */
  now?: () => Date;
  /** LLM for life narratives and nightly reflection; absent = deterministic-only ticks. */
  llm?: () => LlmPort | undefined;
}

export interface RealmTickReport {
  period: RealmRoutinePeriodV1;
  added: number;
  narratives: number;
  reflections: number;
  /** Non-fatal problems (narrative/reflection failures), for logging. */
  notes: readonly string[];
}

export function periodOf(hour: number): RealmRoutinePeriodV1 {
  if (hour >= 6 && hour < 11) return "morning";
  if (hour >= 11 && hour < 17) return "day";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

/** Append an OOC-leak annotation to the analysis reason when detected. */
function annotatedReason(reason: string | undefined, reply: string): string {
  const leak = detectOocLeak(reply);
  if (leak === undefined) return reason ?? "";
  const base = reason && reason.trim().length > 0 ? reason : "no analysis detail";
  return `${base}; ooc-leak: ${leak}`;
}

export class RealmHost {
  private readonly state: RealmStateStore;
  private readonly runner: () => ConversationRunner | undefined;
  private readonly llm: () => LlmPort | undefined;
  private readonly now: () => Date;
  private chatCounter = 0;
  private eventCounter = 0;

  constructor(
    state: RealmStateStore,
    runner: () => ConversationRunner | undefined,
    options: RealmHostOptions = {},
  ) {
    this.state = state;
    this.runner = runner;
    this.llm = options.llm ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
  }

  listAgents(): RealmAgentSummary[] {
    return this.state.config.agents.map((agent) => ({
      agentId: agent.agentId,
      displayName: agent.displayName,
      personaId: agent.personaId,
      affinity: this.state.relationship(agent.agentId)?.affinity ?? 0,
      mood: this.state.mood(agent.agentId),
      affect: this.state.affectState(agent.agentId),
      memoryCount: this.state.memoriesFor(agent.agentId).length,
    }));
  }

  user(): { participantId: string; displayName: string } {
    return this.state.config.user;
  }

  /** Non-destructive store statistics for growth diagnostics. */
  stats(): RealmStoreStats {
    return this.state.stats(this.now().toISOString());
  }

  history(agentId: string, limit = 50): readonly RealmConversationTurnV1[] {
    this.state.agent(agentId);
    return this.state.historyFor(agentId, limit);
  }

  async chat(agentId: string, content: string): Promise<RealmChatResult> {
    const runner = this.runner();
    if (!runner) {
      throw new Error(
        "no conversation llm configured; open /admin to set one up before chatting",
      );
    }
    const agent = this.state.agent(agentId);
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new Error("message content must not be empty");
    }

    const now = this.now().toISOString();
    this.chatCounter += 1;
    const messageId = `msg_${this.now().getTime()}_${this.chatCounter}`;

    const response = await runner.run({
      schemaVersion: REALM_CONVERSATION_SCHEMA_VERSION,
      conversationId: `chat_${agentId}`,
      now,
      agent: {
        agentId: agent.agentId,
        personaId: agent.personaId,
        displayName: agent.displayName,
        persona: agent.persona,
      },
      participant: this.state.config.user,
      memories: this.state.memoriesFor(agentId),
      relationship: this.state.relationship(agentId),
      mood: this.state.mood(agentId),
      affect: this.state.affectState(agentId),
      history: this.state.historyFor(agentId, CHAT_HISTORY_WINDOW),
      message: { messageId, content: trimmed },
    });

    const applied = this.state.applyConversation(
      agentId,
      {
        turns: [
          { role: "participant", content: trimmed, at: now },
          { role: "agent", content: response.reply.content, at: now },
        ],
        memoryWrites: response.memoryWrites,
        affinityDelta: response.affect.affinityDelta,
        mood: response.affect.mood,
      },
      now,
    );

    return {
      agentId,
      displayName: agent.displayName,
      reply: response.reply.content,
      affinity: applied.affinity,
      mood: applied.mood,
      analysis: response.affect.analysis,
      analysisReason: annotatedReason(response.affect.reason, response.reply.content),
    };
  }

  /**
   * Streaming variant of chat(): emits reply text chunks as they arrive and
   * resolves with the same result shape. Runners without runStream() fall
   * back to one delta carrying the whole reply.
   */
  async chatStream(
    agentId: string,
    content: string,
    onDelta: (text: string) => void,
    onReply?: (text: string) => void,
  ): Promise<RealmChatResult> {
    const runner = this.runner();
    if (!runner) {
      throw new Error(
        "no conversation llm configured; open /admin to set one up before chatting",
      );
    }
    const agent = this.state.agent(agentId);
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new Error("message content must not be empty");
    }

    const now = this.now().toISOString();
    this.chatCounter += 1;
    const messageId = `msg_${this.now().getTime()}_${this.chatCounter}`;

    const request = {
      schemaVersion: REALM_CONVERSATION_SCHEMA_VERSION,
      conversationId: `chat_${agentId}`,
      now,
      agent: {
        agentId: agent.agentId,
        personaId: agent.personaId,
        displayName: agent.displayName,
        persona: agent.persona,
      },
      participant: this.state.config.user,
      memories: this.state.memoriesFor(agentId),
      relationship: this.state.relationship(agentId),
      mood: this.state.mood(agentId),
      affect: this.state.affectState(agentId),
      history: this.state.historyFor(agentId, CHAT_HISTORY_WINDOW),
      message: { messageId, content: trimmed },
    };

    const response = runner.runStream
      ? await runner.runStream(request, onDelta, onReply)
      : await runner.run(request).then((result) => {
          onDelta(result.reply.content);
          onReply?.(result.reply.content);
          return result;
        });

    const applied = this.state.applyConversation(
      agentId,
      {
        turns: [
          { role: "participant", content: trimmed, at: now },
          { role: "agent", content: response.reply.content, at: now },
        ],
        memoryWrites: response.memoryWrites,
        affinityDelta: response.affect.affinityDelta,
        mood: response.affect.mood,
      },
      now,
    );

    return {
      agentId,
      displayName: agent.displayName,
      reply: response.reply.content,
      affinity: applied.affinity,
      mood: applied.mood,
      analysis: response.affect.analysis,
      analysisReason: annotatedReason(response.affect.reason, response.reply.content),
    };
  }

  /**
   * Run one tick round if the local (date, period) differs from the persisted
   * last tick — restart-safe: the tick state lives in the data directory, so
   * a restart within the same period never double-ticks.
   *
   * With an LLM available, each ticked agent also gets a first-person life
   * narrative memory, and the night tick runs a daily reflection. Both are
   * best-effort: failures land in `notes` and never abort the tick.
   */
  async tickIfPeriodChanged(): Promise<RealmTickReport | undefined> {
    const date = this.now();
    const period = periodOf(date.getHours());
    const localDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const last = this.state.tickState();
    if (last && last.date === localDate && last.period === period) {
      return undefined;
    }
    const added = this.runTick(period, date);
    this.state.setTickState({ date: localDate, period });

    const notes: string[] = [];
    const narratives = await this.runNarratives(period, date, notes);
    const reflections = period === "night" ? await this.runDailyReflection(date, notes) : 0;

    return { period, added, narratives, reflections, notes };
  }

  private async runNarratives(
    period: RealmRoutinePeriodV1,
    date: Date,
    notes: string[],
  ): Promise<number> {
    const llm = this.llm();
    if (!llm) {
      return 0;
    }
    const now = date.toISOString();
    let written = 0;
    for (const agent of this.state.config.agents) {
      const routine = agent.routines.find((entry) => entry.period === period);
      if (!routine) {
        continue;
      }
      const recentNarratives = this.state
        .memoriesFor(agent.agentId)
        .filter((record) => record.tags.includes("life-narrative"))
        .slice(-NARRATIVE_CONTINUITY_WINDOW)
        .map((record) => record.content);

      const result = await runLifeNarrative(llm, {
        agentId: agent.agentId,
        displayName: agent.displayName,
        persona: agent.persona,
        period,
        locationId: routine.locationId,
        intent: routine.intent,
        now,
        recentNarratives,
      });
      if ("write" in result) {
        this.state.applyMemoryWrites(agent.agentId, [result.write]);
        written += 1;
      } else {
        notes.push(`${agent.agentId}: ${result.error}`);
      }
    }
    return written;
  }

  private async runDailyReflection(date: Date, notes: string[]): Promise<number> {
    const llm = this.llm();
    if (!llm) {
      return 0;
    }
    const now = date.toISOString();
    const localDay = now.slice(0, 10);
    let written = 0;

    for (const agent of this.state.config.agents) {
      // Evidence: today's most important memories, excluding prior reflections.
      const evidence = this.state
        .memoriesFor(agent.agentId)
        .filter((record) => record.kind !== "reflection")
        .filter((record) => record.createdAt.slice(0, 10) === localDay)
        .sort((a, b) => b.importance - a.importance)
        .slice(0, REFLECTION_EVIDENCE_LIMIT);
      if (evidence.length === 0) {
        continue;
      }

      const planner = createLlmReflectionPlanner<RealmMemoryMetadataV1>(llm, {
        personaName: agent.displayName,
        persona: agent.persona,
      });
      const reflection = await runReflection(
        {
          agentId: agent.agentId,
          trigger: {
            kind: "scheduled",
            reason: "nightly reflection over the day's memories",
            now,
            sourceIds: [agent.agentId],
          },
          evidence,
        },
        planner,
      );

      if (reflection.status === "completed" && reflection.memoryWrites.length > 0) {
        // The generic planner leaves metadata empty; stamp the realm metadata
        // so reflection memories join the engine-produced stream correctly.
        const writes = reflection.memoryWrites.map((write) => ({
          ...write,
          metadata: {
            ...(write.metadata as Record<string, unknown>),
            source: "engine",
          } as RealmMemoryMetadataV1,
        }));
        this.state.applyMemoryWrites(agent.agentId, writes);
        written += writes.length;
      } else if (reflection.status !== "completed") {
        const detail = reflection.diagnostics.map((entry) => entry.message).join("; ");
        notes.push(`${agent.agentId}: reflection ${reflection.status}: ${detail}`);
      }
    }
    return written;
  }

  /**
   * Feed one plot event to an agent: the deterministic engine moves the
   * emotional state (decay + event deltas) and proposes the affinity shift;
   * the host applies both immediately and persists.
   */
  plotEvent(
    agentId: string,
    input: { type: PlotEventType; target: PlotEventTarget; intensity?: number },
  ): AffectState {
    this.state.agent(agentId);
    const at = this.now().toISOString();
    this.eventCounter += 1;
    const intensity = Math.min(1, Math.max(0, input.intensity ?? 1));
    const event: PlotEvent = {
      id: `plot_${at}_${this.eventCounter}`,
      type: input.type,
      target: input.target,
      intensity,
      at,
    };
    const current =
      this.state.affectState(agentId) ?? createInitialAffectState(agentId, at);
    const proposal: RealmAffectProposalV1 = {
      affect: applyPlotEvents(current, [event], at),
      affinityDelta: computeAffinityDelta([event]),
    };
    this.state.applyAffectProposal(agentId, proposal, at);
    return proposal.affect;
  }

  private runTick(period: RealmRoutinePeriodV1, date: Date): number {
    const now = date.toISOString();
    // Millisecond timestamp keeps stepIds unique even across restarts within
    // the same hour, so executor-generated memory ids can never collide with
    // records already in the stream.
    const stepId = `step_${date.getTime()}_${period}`;

    const agents = this.state.config.agents
      .map((agent) => {
        const routine = agent.routines.find((entry) => entry.period === period);
        if (!routine) {
          return undefined;
        }
        return {
          perception: {
            agentId: agent.agentId,
            personaId: agent.personaId,
            displayName: agent.displayName,
            status: "idle",
            locationId: routine.locationId,
            period,
            nearbyAgentIds: [],
            activeRoutine: {
              personaId: agent.personaId,
              period,
              index: 0,
              routineId: `${agent.personaId}.${period}.0`,
              planId: `${agent.personaId}.${period}`,
              locationId: routine.locationId,
              intent: routine.intent,
            },
          },
          memories: this.state.memoriesFor(agent.agentId),
          affectState: this.state.affectState(agent.agentId),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

    if (agents.length === 0) {
      return 0;
    }

    const result = executeRealmAgentStepV1({
      schemaVersion: REALM_AGENT_STEP_SCHEMA_VERSION,
      stepId,
      now,
      agents,
    });

    let added = 0;
    for (const output of result.agents) {
      added += this.state.applyTickMemories(output.agentId, output.memories);
      if (output.affectProposal) {
        this.state.applyAffectProposal(output.agentId, output.affectProposal, now);
      }
    }
    return added;
  }
}
