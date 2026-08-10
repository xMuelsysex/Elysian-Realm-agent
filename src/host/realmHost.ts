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
import { AFFECT_DEFAULT_BASELINE } from "../affect/affectRecords.js";
import {
  applyPlotEvents,
  blendConversationEmotion,
  computeAffinityDelta,
  CONVERSATION_EMOTION_BLEND_RATE,
  createInitialAffectState,
} from "../affect/plotRules.js";
import type { RealmAffectProposalV1 } from "../service/realmStepV1.js";
import { runLifeNarrative } from "./lifeNarrative.js";
import { detectOocLeak } from "../conversation/oocGuard.js";
import type { RealmRoutineConfig, RealmStateStore, RealmStoreStats, RealmPersonaConfig } from "./realmState.js";

const CHAT_HISTORY_WINDOW = 20;
const RELATIONSHIP_HISTORY_WINDOW = 20;
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
  /** The agent's most recent nightly reflection, when one exists. */
  latestReflection?: string;
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

/** The character's temperament baseline, or the engine default when absent. */
function personaBaseline(agent: RealmPersonaConfig): { valence: number; arousal: number } {
  if (typeof agent.persona === "object" && agent.persona.baseline !== undefined) {
    return { ...agent.persona.baseline };
  }
  return { ...AFFECT_DEFAULT_BASELINE };
}

/** The character's per-event response multipliers, or undefined when absent. */
function personaAffectModifiers(
  agent: RealmPersonaConfig,
): Partial<Record<PlotEventType, number>> | undefined {
  if (typeof agent.persona === "object" && agent.persona.affectModifiers !== undefined) {
    return { ...agent.persona.affectModifiers };
  }
  return undefined;
}

/** Mood band from an affect snapshot's valence; neutral when absent. */
export function moodBand(affect: AffectState | undefined): "low" | "neutral" | "high" {
  if (affect === undefined) return "neutral";
  if (affect.valence < -0.15) return "low";
  if (affect.valence > 0.15) return "high";
  return "neutral";
}

/**
 * Pick the routine for a period: first candidate whose mood preference
 * matches the current affect band, else the first fallback in order.
 * Deterministic; legacy single-routine configs are unchanged.
 */
export function selectRoutineForPeriod(
  routines: readonly RealmRoutineConfig[],
  period: RealmRoutinePeriodV1,
  affect: AffectState | undefined,
): RealmRoutineConfig | undefined {
  const candidates = routines.filter((entry) => entry.period === period);
  if (candidates.length === 0) {
    return undefined;
  }
  const band = moodBand(affect);
  return (
    candidates.find((entry) => entry.mood === band) ??
    candidates.find((entry) => entry.mood === undefined) ??
    candidates[0]
  );
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
    return this.state.config.agents.map((agent) => {
      const memories = this.state.memoriesFor(agent.agentId);
      const latestReflection = memories
        .filter((record) => record.kind === "reflection")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.content;
      return {
        agentId: agent.agentId,
        displayName: agent.displayName,
        personaId: agent.personaId,
        affinity: this.state.relationship(agent.agentId)?.affinity ?? 0,
        mood: this.state.mood(agent.agentId),
        affect: this.state.affectState(agent.agentId),
        memoryCount: memories.length,
        ...(latestReflection !== undefined ? { latestReflection } : {}),
      };
    });
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
    this.applyConversationEmotion(agentId, response.affect.emotion, now);

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
      relationshipHistory: this.state.relationshipHistory(agentId).slice(-RELATIONSHIP_HISTORY_WINDOW),
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
    this.applyConversationEmotion(agentId, response.affect.emotion, now);

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
    this.ensureAffectInitialized(date);
    const added = this.runTick(period, date);
    this.runScriptedPlot(period, date);
    this.state.setTickState({ date: localDate, period });
    const notes: string[] = [];    const narratives = await this.runNarratives(period, date, notes);
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
      const routine = selectRoutineForPeriod(agent.routines, period, this.state.affectState(agent.agentId));
      if (!routine) {
        continue;
      }
      const recentNarratives = this.state
        .memoriesFor(agent.agentId)
        .filter((record) => record.tags.includes("life-narrative"))
        .slice(-NARRATIVE_CONTINUITY_WINDOW)
        .map((record) => record.content);

      // Stamp the agent's current affect onto the narrative memory so the
      // tick track also carries an emotional signature (affect.md candidate),
      // and inject it into the diary prompt so the mood colors the writing.
      const affect = this.state.affectState(agent.agentId);
      const result = await runLifeNarrative(llm, {
        agentId: agent.agentId,
        displayName: agent.displayName,
        persona: agent.persona,
        period,
        locationId: routine.locationId,
        intent: routine.intent,
        now,
        recentNarratives,
        ...(affect !== undefined ? { affect, emotion: { valence: affect.valence, arousal: affect.arousal } } : {}),
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

      // Relationship arc: quote today's affinity trajectory when it moved.
      const history = this.state.relationshipHistory(agent.agentId, `${localDay}T00:00:00.000Z`);
      const relationshipArc =
        history.length >= 2 && history[0].affinity !== history[history.length - 1].affinity
          ? `Relationship arc today: your bond with ${this.state.config.user.displayName} moved from ${history[0].affinity} to ${history[history.length - 1].affinity} (scale -100..100).`
          : undefined;

      const planner = createLlmReflectionPlanner<RealmMemoryMetadataV1>(llm, {
        personaName: agent.displayName,
        persona: agent.persona,
        ...(relationshipArc !== undefined ? { relationshipArc } : {}),
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
      this.state.affectState(agentId) ?? createInitialAffectState(agentId, at, personaBaseline(this.state.agent(agentId)));
    const proposal: RealmAffectProposalV1 = {
      affect: applyPlotEvents(
        current,
        [event],
        at,
        personaAffectModifiers(this.state.agent(agentId)),
      ),
      affinityDelta: computeAffinityDelta([event], personaAffectModifiers(this.state.agent(agentId))),
    };
    this.state.applyAffectProposal(agentId, proposal, at);
    return proposal.affect;
  }

  /**
   * Give every agent an affect state on first tick, anchored at the
   * character's temperament baseline (ACT fundamental sentiments) so decay
   * regresses toward their own disposition, not a shared default.
   */
  private ensureAffectInitialized(date: Date): void {
    const now = date.toISOString();
    for (const agent of this.state.config.agents) {
      if (this.state.affectState(agent.agentId) === undefined) {
        this.state.applyAffectProposal(
          agent.agentId,
          {
            affect: createInitialAffectState(agent.agentId, now, personaBaseline(agent)),
            affinityDelta: 0,
          },
          now,
        );
      }
    }
  }

  /**
   * Conversation emotional feedback: nudge the affect snapshot toward the
   * exchange's emotional signature (small weight), so feelings carry inertia
   * between turns while plot events stay dominant. No-op without a signature.
   */
  private applyConversationEmotion(
    agentId: string,
    emotion: { valence: number; arousal: number } | undefined,
    now: string,
  ): void {
    if (emotion === undefined) {
      return;
    }
    const agent = this.state.agent(agentId);
    const current =
      this.state.affectState(agentId) ?? createInitialAffectState(agentId, now, personaBaseline(agent));
    // Emotional expressiveness is a character trait: the blend weight comes
    // from the persona (default 0.1), so composed characters barely move.
    const rate =
      typeof agent.persona === "object" && agent.persona.emotionResponsiveness !== undefined
        ? agent.persona.emotionResponsiveness
        : CONVERSATION_EMOTION_BLEND_RATE;
    this.state.applyAffectProposal(
      agentId,
      {
        affect: blendConversationEmotion(current, emotion, now, rate),
        affinityDelta: 0,
      },
      now,
    );
  }

  /** Feed each agent's scripted plot events for this period, if configured. */
  private runScriptedPlot(period: RealmRoutinePeriodV1, date: Date): void {
    const at = date.toISOString();
    for (const agent of this.state.config.agents) {
      const script = agent.plotScript?.find((entry) => entry.period === period);
      if (!script || script.events.length === 0) {
        continue;
      }
      for (const event of script.events) {
        this.plotEvent(agent.agentId, event);
      }
    }
  }

  private runTick(period: RealmRoutinePeriodV1, date: Date): number {
    const now = date.toISOString();
    // Millisecond timestamp keeps stepIds unique even across restarts within
    // the same hour, so executor-generated memory ids can never collide with
    // records already in the stream.
    const stepId = `step_${date.getTime()}_${period}`;

    const agents = this.state.config.agents
      .map((agent) => {
        const routine = selectRoutineForPeriod(
          agent.routines,
          period,
          this.state.affectState(agent.agentId),
        );
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
