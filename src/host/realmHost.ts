// Realm host orchestration: the authoritative process around the stateless
// cores. Chat requests flow persona/memory/affect state into the conversation
// runner and APPLY the returned proposals (memory writes, affinity delta,
// mood) to the persisted state — closing the loop the service contracts leave
// to the host. Ticks run the deterministic step when the real-clock period
// changes, so agents accumulate a daily life between conversations.
//
// No pi imports here: the runner arrives via its port interface.

import {
  buildConversationMemoryWrites,
  CONVERSATION_MEMORY_IMPORTANCE,
  type ConversationRunner,
} from "../conversation/conversationRunner.js";
import type { LlmPort } from "../ports/ports.js";
import {
  REALM_CONVERSATION_SCHEMA_VERSION,
  resolvePersonalityDimensions,
  type PersonalityDimensionKey,
  type RealmConversationRequestV1,
  type RealmConversationResponseV1,
  type RealmConversationTurnV1,
  type RealmPersonalityDimensionsV1,
} from "../service/realmConversationV1.js";
import {
  REALM_AGENT_STEP_SCHEMA_VERSION,
  type RealmMemoryMetadataV1,
  type RealmRoutinePeriodV1,
} from "../service/realmStepV1.js";
import { executeRealmAgentStepV1 } from "../service/realmStepExecutor.js";
import type { MemoryRecord } from "../memory/memoryRecords.js";
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
import { PLOT_EVENT_LABELS, PLOT_EVENT_TYPES } from "../affect/affectRecords.js";
import type { RealmAffectProposalV1 } from "../service/realmStepV1.js";
import { runLifeNarrative } from "./lifeNarrative.js";
import {
  detectOocLeak,
  isCharacterVisibleMemory,
  isCharacterVisibleMood,
  isCharacterVisibleParticipantMessage,
} from "../conversation/oocGuard.js";
import type { RealmRoutineConfig, RealmStateStore, RealmStoreStats, RealmPersonaConfig } from "./realmState.js";
import { RealmProfileManager, type RealmProfileManagerInput, type RealmProfileSummary } from "./realmProfiles.js";
import {
  SELF_CONCEPT_AUDIT_SCHEMA_VERSION,
  type SelfConceptProposalV1,
} from "../selfConcept/selfConceptRecords.js";
import { ELYSIAN_REALM_CANON } from "../lore/elysianRealmCanon.js";
import { ELYSIAN_REALM_DIALOGUE } from "../lore/elysianRealmDialogue.js";
import { retrieveLoreEntries } from "../lore/loreRetrieval.js";
import { retrieveLoreDialogue } from "../lore/loreDialogueRetrieval.js";
import { renderLoreDialogueContext } from "../lore/loreDialoguePrompt.js";
import { dialogueLinesForSpeaker, dialogueSpeakerAliases } from "../lore/loreDialogueRecords.js";
import {
  generateStoryOverview,
  STORY_OVERVIEW_SCENE_LIMIT,
  type StoryOverviewSourceScene,
} from "./storyOverview.js";
import {
  personalityEventResponseMultiplier,
  personalityRoutineScore,
} from "../personality/personalityRules.js";
import {
  DEFAULT_LORE_RETRIEVAL_TOP_K,
  validateLoreEntries,
  type LoreEntryV1,
} from "../lore/loreRecords.js";
import {
  validateLoreDialogueCatalog,
  type LoreDialogueCatalogV1,
  type LoreDialogueLineV1,
  type LoreDialogueRetrievalHitV1,
} from "../lore/loreDialogueRecords.js";

const CHAT_HISTORY_WINDOW = 20;
const RELATIONSHIP_HISTORY_WINDOW = 20;
const PLOT_EVENT_MEMORY_IMPORTANCE = 3;
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

/** Read-only data shown by the authenticated admin dashboard. */
export interface RealmAgentAdminView extends RealmAgentSummary {
  personalityDimensions: Record<PersonalityDimensionKey, number>;
  memories: readonly MemoryRecord<RealmMemoryMetadataV1>[];
}

export interface RealmProfileAdminView extends RealmProfileSummary {
  agents: readonly RealmAgentAdminView[];
}

export interface RealmStorySceneAdminView {
  id: string;
  order: number;
  title: string;
  chapterId: string;
  sourceUrl: string;
  available: boolean;
}

export interface RealmStoryAdminView {
  cursor: number;
  updatedAt: string;
  totalScenes: number;
  source: string;
  chapters: readonly {
    id: string;
    title: string;
    sceneIds: readonly string[];
  }[];
  scenes: readonly RealmStorySceneAdminView[];
  diagnostics: readonly { sourceUrl: string; status: number; message: string }[];
}

export interface RealmStoryOverviewScene {
  id: string;
  order: number;
  title: string;
  chapterTitle: string;
  summary: string;
}

export interface RealmStoryOverview {
  status: "ready" | "empty";
  profileId: string;
  agentId: string;
  cursor: number;
  message?: string;
  currentScene?: Pick<RealmStoryOverviewScene, "id" | "order" | "title" | "chapterTitle">;
  recentScenes: readonly RealmStoryOverviewScene[];
  overview?: string;
  questions: readonly string[];
}

/** One exact transcript fragment supplied to a conversation request. */
export interface RealmStoryInspectionHit {
  scene: {
    id: string;
    arcId: string;
    chapterId: string;
    chapterTitle: string;
    order: number;
    title: string;
    sourceUrl: string;
  };
  score: number;
  lines: readonly Pick<LoreDialogueLineV1, "id" | "stageId" | "sourceIndex" | "kind" | "speaker" | "text">[];
}

/** Read-only trace used by the local story test interface. */
export interface RealmConversationInspection {
  profileId: string;
  conversationId: string;
  now: string;
  agent: { agentId: string; personaId: string; displayName: string };
  participant: { participantId: string; displayName: string; profile?: string };
  message: string;
  historyTurns: number;
  memoryCount: number;
  storyCursor: number;
  storyContext: readonly RealmStoryInspectionHit[];
  storyPrompt: string;
}

export interface RealmHostOptions {
  /** Injectable clock for tests. */
  now?: () => Date;
  /** LLM for life narratives and nightly reflection; absent = deterministic-only ticks. */
  llm?: () => LlmPort | undefined;
  /** Curated read-only world canon; defaults to the bundled Elysian Realm canon. */
  lore?: readonly LoreEntryV1[];
  /** Local full transcript snapshot; defaults to the bundled BH3Text snapshot. */
  loreDialogue?: LoreDialogueCatalogV1;
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

/**
 * Keep legacy OOC assistant turns out of the next model context while leaving
 * the stored diagnostic history available to the host and admin views.
 */
function characterVisibleHistory(
  state: RealmStateStore,
  agentId: string,
): readonly RealmConversationTurnV1[] {
  return state.historyFor(agentId, CHAT_HISTORY_WINDOW).filter((turn) => (
    turn.role === "agent"
      ? detectOocLeak(turn.content) === undefined
      : isCharacterVisibleParticipantMessage(turn.content)
  ));
}

/** Append an OOC-leak annotation to the analysis reason when detected. */
function annotatedReason(
  reason: string | undefined,
  reply: string,
  mood?: { mood: string; intensity: number },
): string {
  const notes: string[] = [];
  const leak = detectOocLeak(reply);
  if (leak !== undefined) notes.push(`ooc-leak: ${leak}`);
  if (mood !== undefined && !isCharacterVisibleMood(mood.mood)) {
    notes.push("mood quarantined: unsafe or overlong text");
  }
  if (notes.length === 0) return reason ?? "";
  const base = reason && reason.trim().length > 0 ? reason : "no analysis detail";
  return `${base}; ${notes.join("; ")}`;
}

function detectSelfConceptOocLeak(proposal: SelfConceptProposalV1): string | undefined {
  for (const text of [proposal.summary, ...proposal.beliefs.map((belief) => belief.statement)]) {
    const leak = detectOocLeak(text);
    if (leak !== undefined) return leak;
  }
  return undefined;
}

/** The character's temperament baseline, or the engine default when absent. */
function personaBaseline(agent: RealmPersonaConfig): { valence: number; arousal: number } {
  if (typeof agent.persona === "object" && agent.persona.baseline !== undefined) {
    return { ...agent.persona.baseline };
  }
  return { ...AFFECT_DEFAULT_BASELINE };
}

/** 返回显式事件倍率与六维人格固定倍率的合成结果。 */
function personaAffectModifiers(
  agent: RealmPersonaConfig,
): Partial<Record<PlotEventType, number>> | undefined {
  if (typeof agent.persona !== "object") {
    return undefined;
  }
  const explicit = agent.persona.affectModifiers;
  const dimensions = agent.persona.personalityDimensions;
  if (explicit === undefined && dimensions === undefined) {
    return undefined;
  }
  return Object.fromEntries(
    PLOT_EVENT_TYPES.map((type) => [
      type,
      (explicit?.[type] ?? 1) * personalityEventResponseMultiplier(type, dimensions),
    ]),
  ) as Partial<Record<PlotEventType, number>>;
}

/** Mood band from an affect snapshot's valence; neutral when absent. */
export function moodBand(affect: AffectState | undefined): "low" | "neutral" | "high" {
  if (affect === undefined) return "neutral";
  if (affect.valence < -0.15) return "low";
  if (affect.valence > 0.15) return "high";
  return "neutral";
}

/** 按情绪优先、人格偏好次之、声明顺序兜底选择例程。 */
export function selectRoutineForPeriod(
  routines: readonly RealmRoutineConfig[],
  period: RealmRoutinePeriodV1,
  affect: AffectState | undefined,
  dimensions?: RealmPersonalityDimensionsV1,
): RealmRoutineConfig | undefined {
  const candidates = routines.filter((entry) => entry.period === period);
  if (candidates.length === 0) {
    return undefined;
  }
  const band = moodBand(affect);
  const moodMatches = candidates.filter((entry) => entry.mood === band);
  const fallbacks = candidates.filter((entry) => entry.mood === undefined);
  const pool = moodMatches.length > 0
    ? moodMatches
    : fallbacks.length > 0
      ? fallbacks
      : candidates;
  let selected = pool[0];
  let selectedScore = personalityRoutineScore(dimensions, selected.personalityBias);
  for (const candidate of pool.slice(1)) {
    const score = personalityRoutineScore(dimensions, candidate.personalityBias);
    if (score > selectedScore) {
      selected = candidate;
      selectedScore = score;
    }
  }
  return selected;
}

export class RealmHost {
  private readonly state: RealmStateStore;
  private readonly profiles?: RealmProfileManager;
  private readonly runner: () => ConversationRunner | undefined;
  private readonly llm: () => LlmPort | undefined;
  private readonly now: () => Date;
  private readonly lore: readonly LoreEntryV1[];
  private readonly loreDialogue: LoreDialogueCatalogV1;
  private chatCounter = 0;
  private eventCounter = 0;

  constructor(
    state: RealmStateStore | RealmProfileManager,
    runner: () => ConversationRunner | undefined,
    options: RealmHostOptions = {},
  ) {
    if (state instanceof RealmProfileManager) {
      this.profiles = state;
      this.state = state.stateFor();
    } else {
      this.state = state;
    }
    this.runner = runner;
    this.llm = options.llm ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
    this.lore = validateLoreEntries(options.lore ?? ELYSIAN_REALM_CANON);
    this.loreDialogue = validateLoreDialogueCatalog(options.loreDialogue ?? ELYSIAN_REALM_DIALOGUE);
  }

  private stateFor(profileId?: string): RealmStateStore {
    if (this.profiles !== undefined) {
      return this.profiles.stateFor(profileId);
    }
    if (profileId !== undefined && profileId !== this.state.config.user.participantId) {
      throw new Error(`unknown profileId: ${profileId}`);
    }
    return this.state;
  }

  listProfiles(): RealmProfileSummary[] {
    if (this.profiles !== undefined) {
      return this.profiles.listProfiles();
    }
    return [{
      profileId: this.state.config.user.participantId,
      displayName: this.state.config.user.displayName,
      ...(this.state.config.user.profile !== undefined ? { profile: this.state.config.user.profile } : {}),
      storyCursor: this.state.storyProgress().cursor,
    }];
  }

  createProfile(input: RealmProfileManagerInput): RealmProfileSummary {
    if (this.profiles === undefined) {
      throw new Error("profile management is not enabled");
    }
    return this.profiles.createProfile(input);
  }

  updateProfile(profileId: string, input: { displayName: string; profile?: string }): RealmProfileSummary {
    if (this.profiles === undefined) {
      throw new Error("profile management is not enabled");
    }
    return this.profiles.updateProfile(profileId, input);
  }

  storyProgress(profileId?: string): RealmStoryAdminView {
    const state = this.stateFor(profileId);
    return {
      ...state.storyProgress(),
      totalScenes: this.loreDialogue.scenes.length,
      source: this.loreDialogue.source,
      chapters: this.loreDialogue.chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        sceneIds: chapter.sceneIds,
      })),
      scenes: this.loreDialogue.scenes.map(({ id, order, title, chapterId, sourceUrl, available }) => ({
        id,
        order,
        title,
        chapterId,
        sourceUrl,
        available,
      })),
      diagnostics: this.loreDialogue.diagnostics ?? [],
    };
  }

  async storyOverview(agentId: string, profileId?: string): Promise<RealmStoryOverview> {
    const state = this.stateFor(profileId);
    const agent = state.agent(agentId);
    const resolvedProfileId = state.config.user.participantId;
    const cursor = state.storyProgress().cursor;
    const empty = (message: string): RealmStoryOverview => ({
      status: "empty",
      profileId: resolvedProfileId,
      agentId,
      cursor,
      message,
      recentScenes: [],
      questions: [],
    });

    if (cursor <= 0) {
      return empty("当前剧情尚未解锁");
    }

    const aliases = dialogueSpeakerAliases(agent.displayName, agent.personaId);
    const sourceScenes = this.loreDialogue.scenes
      .filter((scene) => scene.available && scene.order < cursor)
      .sort((left, right) => right.order - left.order)
      .map((scene): StoryOverviewSourceScene => ({
        sceneId: scene.id,
        order: scene.order,
        title: scene.title,
        chapterTitle: this.loreDialogue.chapters.find((chapter) => chapter.id === scene.chapterId)?.title ?? scene.chapterId,
        lines: dialogueLinesForSpeaker(scene, aliases),
      }))
      .filter((scene) => scene.lines.length > 0);
    const currentScene = sourceScenes.find((scene) => scene.order === cursor - 1);
    if (currentScene === undefined) {
      return empty("当前剧情暂无该角色可见原文");
    }

    const recentScenes = sourceScenes.slice(0, STORY_OVERVIEW_SCENE_LIMIT).reverse();
    const llm = this.llm();
    if (llm === undefined) {
      throw new Error("no conversation llm configured; open /admin to set one up before generating the story overview");
    }
    const generated = await generateStoryOverview(llm, {
      characterName: agent.displayName,
      scenes: recentScenes,
    });
    const sceneById = new Map(recentScenes.map((scene) => [scene.sceneId, scene]));

    return {
      status: "ready",
      profileId: resolvedProfileId,
      agentId,
      cursor,
      currentScene: {
        id: currentScene.sceneId,
        order: currentScene.order,
        title: currentScene.title,
        chapterTitle: currentScene.chapterTitle,
      },
      recentScenes: generated.recaps.map((recap) => {
        const scene = sceneById.get(recap.sceneId);
        if (scene === undefined) {
          throw new Error(`story overview returned unknown scene: ${recap.sceneId}`);
        }
        return {
          id: scene.sceneId,
          order: scene.order,
          title: scene.title,
          chapterTitle: scene.chapterTitle,
          summary: recap.text,
        };
      }),
      overview: generated.overview,
      questions: generated.questions,
    };
  }

  setStoryCursor(profileId: string | undefined, cursor: number): RealmStoryAdminView {
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > this.loreDialogue.scenes.length) {
      throw new Error(`story cursor must be an integer from 0 to ${this.loreDialogue.scenes.length}`);
    }
    const state = this.stateFor(profileId);
    const current = state.storyProgress().cursor;
    const at = this.now().toISOString();
    if (cursor !== current) {
      state.saveStoryCheckpoint(current);
      if (cursor < current) {
        state.restoreStoryCheckpoint(cursor, at);
      } else {
        state.setStoryCursor(cursor, at);
      }
      state.clearStoryCheckpointsAfter(cursor);
    }
    return this.storyProgress(profileId);
  }

  listAgents(profileId?: string): RealmAgentSummary[] {
    const state = this.stateFor(profileId);
    return state.config.agents.map((agent) => {
      const memories = state.memoriesFor(agent.agentId);
      const latestReflection = memories
        .filter((record) => record.kind === "reflection")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.content;
      return {
        agentId: agent.agentId,
        displayName: agent.displayName,
        personaId: agent.personaId,
        affinity: state.relationship(agent.agentId)?.affinity ?? 0,
        mood: state.mood(agent.agentId),
        affect: state.affectState(agent.agentId),
        memoryCount: memories.length,
        ...(latestReflection !== undefined ? { latestReflection } : {}),
      };
    });
  }

  adminView(profileId?: string): RealmAgentAdminView[] {
    const state = this.stateFor(profileId);
    const summaries = this.listAgents(profileId);
    return summaries.map((summary) => {
      const agent = state.agent(summary.agentId);
      const memories = state
        .memoriesFor(summary.agentId)
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 100);
      return {
        ...summary,
        personalityDimensions: resolvePersonalityDimensions(
          typeof agent.persona === "object" ? agent.persona.personalityDimensions : undefined,
        ),
        memories,
      };
    });
  }

  user(profileId?: string): { participantId: string; displayName: string; profile?: string } {
    return { ...this.stateFor(profileId).config.user };
  }

  /** Non-destructive store statistics for growth diagnostics. */
  stats(profileId?: string): RealmStoreStats {
    return this.stateFor(profileId).stats(this.now().toISOString());
  }

  history(agentId: string, limit = 50, profileId?: string): readonly RealmConversationTurnV1[] {
    const state = this.stateFor(profileId);
    state.agent(agentId);
    return state.historyFor(agentId, limit);
  }

  /**
   * Start a new conversation with one agent: clear the visible transcript so the
   * next message opens a fresh context. Long-term state (memories, affect,
   * mood, relationship, story progress) is untouched.
   */
  newConversation(agentId: string, profileId?: string): number {
    const state = this.stateFor(profileId);
    state.agent(agentId);
    return state.clearConversation(agentId);
  }

  /** Build a read-only trace of the story excerpts selected for one message. */
  inspectConversation(agentId: string, content: string, profileId?: string): RealmConversationInspection {
    const state = this.stateFor(profileId);
    const agent = state.agent(agentId);
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new Error("message content must not be empty");
    }
    const now = this.now().toISOString();
    const history = characterVisibleHistory(state, agentId);
    const storyContext = this.storyContextFor(
      state,
      agent,
      [...history.map((turn) => turn.content), trimmed].join("\\n"),
    );
    const storyContextForInspection = storyContext.map((hit) => {
      const chapter = this.loreDialogue.chapters.find((entry) => entry.id === hit.scene.chapterId);
      return {
        scene: {
          id: hit.scene.id,
          arcId: hit.scene.arcId,
          chapterId: hit.scene.chapterId,
          chapterTitle: chapter?.title ?? hit.scene.chapterId,
          order: hit.scene.order,
          title: hit.scene.title,
          sourceUrl: hit.scene.sourceUrl,
        },
        score: hit.score,
        lines: hit.lines.map((line) => ({
          id: line.id,
          stageId: line.stageId,
          sourceIndex: line.sourceIndex,
          kind: line.kind,
          ...(line.speaker !== undefined ? { speaker: line.speaker } : {}),
          text: line.text,
        })),
      };
    });
    return {
      profileId: state.config.user.participantId,
      conversationId: `chat_${state.config.user.participantId}_${agentId}`,
      now,
      agent: { agentId: agent.agentId, personaId: agent.personaId, displayName: agent.displayName },
      participant: state.config.user,
      message: trimmed,
      historyTurns: history.length,
      memoryCount: state.memoriesFor(agentId).length,
      storyCursor: state.storyProgress().cursor,
      storyContext: storyContextForInspection,
      storyPrompt: renderLoreDialogueContext(
        storyContext,
        undefined,
        dialogueSpeakerAliases(agent.displayName, agent.personaId),
      ) ?? "",
    };
  }

  private storyContextFor(
    state: RealmStateStore,
    agent: RealmPersonaConfig,
    text: string,
  ): readonly LoreDialogueRetrievalHitV1[] {
    return retrieveLoreDialogue(this.loreDialogue, {
      cursor: state.storyProgress().cursor,
      speakerAliases: dialogueSpeakerAliases(agent.displayName, agent.personaId),
      text,
    }).hits;
  }

  private availableSummaryLore(): readonly LoreEntryV1[] {
    // The imported dialogue catalog is the staged canon. Keeping the older
    // unscoped summaries out of model requests prevents future spoilers.
    return this.loreDialogue.scenes.length === 0 ? this.lore : [];
  }

  async chat(agentId: string, content: string, profileId?: string): Promise<RealmChatResult> {
    const runner = this.runner();
    if (!runner) {
      throw new Error(
        "no conversation llm configured; open /admin to set one up before chatting",
      );
    }
    const state = this.stateFor(profileId);
    const agent = state.agent(agentId);
    const storyGeneration = state.storyGeneration();
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new Error("message content must not be empty");
    }

    const now = this.now().toISOString();
    this.chatCounter += 1;
    const messageId = `msg_${this.now().getTime()}_${this.chatCounter}`;
    const history = characterVisibleHistory(state, agentId);

    const request: RealmConversationRequestV1 = {
      schemaVersion: REALM_CONVERSATION_SCHEMA_VERSION,
      conversationId: `chat_${profileId ?? this.state.config.user.participantId}_${agentId}`,
      now,
      agent: {
        agentId: agent.agentId,
        personaId: agent.personaId,
        displayName: agent.displayName,
        persona: agent.persona,
      },
      participant: state.config.user,
      memories: state.memoriesFor(agentId),
      relationship: state.relationship(agentId),
      relationshipHistory: state.relationshipHistory(agentId).slice(-RELATIONSHIP_HISTORY_WINDOW),
      mood: state.mood(agentId),
      affect: state.affectState(agentId),
      selfConcept: state.getSelfConceptSnapshot(agentId),
      lore: this.availableSummaryLore(),
      storyContext: this.storyContextFor(
        state,
        agent,
        [...history.map((turn) => turn.content), trimmed].join("\n"),
      ),
      history,
      message: { messageId, content: trimmed },
    };
    const response = await runner.run(request);

    state.assertStoryGeneration(storyGeneration);
    const { applied } = this.applyChatResponse(
      state,
      request,
      response,
      now,
    );

    return {
      agentId,
      displayName: agent.displayName,
      reply: response.reply.content,
      affinity: applied.affinity,
      mood: applied.mood,
      analysis: response.affect.analysis,
      analysisReason: annotatedReason(response.affect.reason, response.reply.content, response.affect.mood),
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
    profileId?: string,
  ): Promise<RealmChatResult> {
    const runner = this.runner();
    if (!runner) {
      throw new Error(
        "no conversation llm configured; open /admin to set one up before chatting",
      );
    }
    const state = this.stateFor(profileId);
    const agent = state.agent(agentId);
    const storyGeneration = state.storyGeneration();
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new Error("message content must not be empty");
    }

    const now = this.now().toISOString();
    this.chatCounter += 1;
    const messageId = `msg_${this.now().getTime()}_${this.chatCounter}`;
    const history = characterVisibleHistory(state, agentId);

    const request: RealmConversationRequestV1 = {
      schemaVersion: REALM_CONVERSATION_SCHEMA_VERSION,
      conversationId: `chat_${profileId ?? this.state.config.user.participantId}_${agentId}`,
      now,
      agent: {
        agentId: agent.agentId,
        personaId: agent.personaId,
        displayName: agent.displayName,
        persona: agent.persona,
      },
      participant: state.config.user,
      memories: state.memoriesFor(agentId),
      relationship: state.relationship(agentId),
      relationshipHistory: state.relationshipHistory(agentId).slice(-RELATIONSHIP_HISTORY_WINDOW),
      mood: state.mood(agentId),
      affect: state.affectState(agentId),
      selfConcept: state.getSelfConceptSnapshot(agentId),
      lore: this.availableSummaryLore(),
      storyContext: this.storyContextFor(
        state,
        agent,
        [...history.map((turn) => turn.content), trimmed].join("\n"),
      ),
      history,
      message: { messageId, content: trimmed },
    };

    const onReplyForGeneration = onReply === undefined
      ? undefined
      : (reply: string) => {
          state.assertStoryGeneration(storyGeneration);
          onReply(reply);
        };
    const response = runner.runStream
      ? await runner.runStream(request, onDelta, onReplyForGeneration)
      : await runner.run(request).then((result) => {
          onDelta(result.reply.content);
          onReplyForGeneration?.(result.reply.content);
          return result;
        });

    state.assertStoryGeneration(storyGeneration);
    const { applied } = this.applyChatResponse(
      state,
      request,
      response,
      now,
    );

    return {
      agentId,
      displayName: agent.displayName,
      reply: response.reply.content,
      affinity: applied.affinity,
      mood: applied.mood,
      analysis: response.affect.analysis,
      analysisReason: annotatedReason(response.affect.reason, response.reply.content, response.affect.mood),
    };
  }

  /**
   * Apply a reply only after checking the generated text for a persona leak.
   * A leaked reply remains visible to the caller for diagnosis, while its
   * generated memory, affect, relationship delta, and history turn are kept
   * out of the durable loop.
   */
  private applyChatResponse(
    state: RealmStateStore,
    request: RealmConversationRequestV1,
    response: RealmConversationResponseV1,
    now: string,
  ): { applied: ReturnType<RealmStateStore["applyConversation"]>; leak?: string } {
    const leak = detectOocLeak(response.reply.content);
    const turns: RealmConversationTurnV1[] = leak === undefined
      ? [
          { role: "participant", content: request.message.content, at: now },
          { role: "agent", content: response.reply.content, at: now },
        ]
      : [{ role: "participant", content: request.message.content, at: now }];
    const memoryWrites = leak === undefined
      ? response.memoryWrites
      : [buildConversationMemoryWrites(request, "", CONVERSATION_MEMORY_IMPORTANCE)[0]];
    const visibleMood = leak === undefined && response.affect.mood !== undefined && isCharacterVisibleMood(response.affect.mood.mood)
      ? response.affect.mood
      : undefined;
    const applied = state.applyConversation(
      request.agent.agentId,
      {
        turns,
        memoryWrites,
        ...(leak === undefined
          ? {
              affinityDelta: response.affect.affinityDelta,
              ...(visibleMood !== undefined ? { mood: visibleMood } : {}),
            }
          : {}),
      },
      now,
    );
    if (leak === undefined) {
      this.applyConversationEmotion(request.agent.agentId, response.affect.emotion, now, state);
    }
    return { applied, ...(leak !== undefined ? { leak } : {}) };
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
    const states = this.profiles?.allStates() ?? [this.state];
    const reports: RealmTickReport[] = [];
    for (const state of states) {
      const report = await this.tickStateIfPeriodChanged(state, period, localDate, date);
      if (report !== undefined) reports.push(report);
    }
    if (reports.length === 0) return undefined;
    return {
      period,
      added: reports.reduce((total, report) => total + report.added, 0),
      narratives: reports.reduce((total, report) => total + report.narratives, 0),
      reflections: reports.reduce((total, report) => total + report.reflections, 0),
      notes: reports.flatMap((report) => report.notes),
    };
  }

  private async tickStateIfPeriodChanged(
    state: RealmStateStore,
    period: RealmRoutinePeriodV1,
    localDate: string,
    date: Date,
  ): Promise<RealmTickReport | undefined> {
    const last = state.tickState();
    if (last && last.date === localDate && last.period === period) {
      return undefined;
    }
    const storyGeneration = state.storyGeneration();
    this.ensureAffectInitialized(state, date);
    const added = this.runTick(period, date, state);
    this.runScriptedPlot(period, date, state);
    state.setTickState({ date: localDate, period });
    const notes: string[] = [];
    const narratives = await this.runNarratives(period, date, notes, state, storyGeneration);
    const reflections = period === "night" ? await this.runDailyReflection(date, notes, state, storyGeneration) : 0;
    return { period, added, narratives, reflections, notes };
  }

  private async runNarratives(
    period: RealmRoutinePeriodV1,
    date: Date,
    notes: string[],
    state: RealmStateStore,
    storyGeneration: number,
  ): Promise<number> {
    const llm = this.llm();
    if (!llm) {
      return 0;
    }
    const now = date.toISOString();
    let written = 0;
    for (const agent of state.config.agents) {
      if (state.storyGeneration() !== storyGeneration) {
        notes.push(`${state.config.user.participantId}: narrative discarded after story changed`);
        return written;
      }
      const routine = selectRoutineForPeriod(
        agent.routines,
        period,
        state.affectState(agent.agentId),
        typeof agent.persona === "object" ? agent.persona.personalityDimensions : undefined,
      );
      if (!routine) {
        continue;
      }
      const recentNarratives = state
        .memoriesFor(agent.agentId)
        .filter((record) => record.tags.includes("life-narrative"))
        .filter(isCharacterVisibleMemory)
        .slice(-NARRATIVE_CONTINUITY_WINDOW)
        .map((record) => record.content);

      // Stamp the agent's current affect onto the narrative memory so the
      // tick track also carries an emotional signature (affect.md candidate),
      // and inject it into the diary prompt so the mood colors the writing.
      const affect = state.affectState(agent.agentId);
      // Diary can reference the day's relationship arc when it moved.
      const localDay = now.slice(0, 10);
      const dayHistory = state.relationshipHistory(agent.agentId, `${localDay}T00:00:00.000Z`);
      const relationshipArc =
        dayHistory.length >= 2 && dayHistory[0].affinity !== dayHistory[dayHistory.length - 1].affinity
          ? `Relationship today: your bond with ${state.config.user.displayName} moved from ${dayHistory[0].affinity} to ${dayHistory[dayHistory.length - 1].affinity} (scale -100..100).`
          : undefined;
      const loreQuery = [routine.intent, ...recentNarratives].join("\n");
      const loreHits = retrieveLoreEntries(this.availableSummaryLore(), {
        agentId: agent.agentId,
        text: loreQuery,
        topK: DEFAULT_LORE_RETRIEVAL_TOP_K,
      }).hits;
      const storyContext = this.storyContextFor(state, agent, loreQuery);
      const result = await runLifeNarrative(llm, {
        agentId: agent.agentId,
        displayName: agent.displayName,
        personaId: agent.personaId,
        persona: agent.persona,
        period,
        locationId: routine.locationId,
        intent: routine.intent,
        now,
        recentNarratives,
        ...(affect !== undefined ? { affect, emotion: { valence: affect.valence, arousal: affect.arousal } } : {}),
        ...(relationshipArc !== undefined ? { relationshipArc } : {}),
        loreHits,
        storyContext,
        selfConcept: state.getSelfConceptSnapshot(agent.agentId),
      });
      if (state.storyGeneration() !== storyGeneration) {
        notes.push(`${state.config.user.participantId}: narrative discarded after story changed`);
        return written;
      }
      if ("write" in result) {
        // Keep leaked diary text visible in the tick report, but out of the
        // lived-memory stream so later prompts cannot reinforce the mistake.
        const leak = detectOocLeak(result.write.content);
        if (leak !== undefined) {
          notes.push(`${agent.agentId}: narrative ooc-leak: ${leak} (quarantined)`);
          continue;
        }
        state.applyMemoryWrites(agent.agentId, [result.write]);
        written += 1;
      } else {
        notes.push(`${agent.agentId}: ${result.error}`);
      }
    }
    return written;
  }

  private async runDailyReflection(
    date: Date,
    notes: string[],
    state: RealmStateStore,
    storyGeneration: number,
  ): Promise<number> {
    const llm = this.llm();
    if (!llm) {
      return 0;
    }
    const now = date.toISOString();
    const localDay = now.slice(0, 10);
    let written = 0;

    for (const agent of state.config.agents) {
      if (state.storyGeneration() !== storyGeneration) {
        notes.push(`${state.config.user.participantId}: reflection discarded after story changed`);
        return written;
      }
      // Evidence: today's most important memories, excluding prior reflections.
      const evidence = state
        .memoriesFor(agent.agentId)
        .filter((record) => record.kind !== "reflection")
        .filter(isCharacterVisibleMemory)
        .filter((record) => record.createdAt.slice(0, 10) === localDay)
        .sort((a, b) => b.importance - a.importance)
        .slice(0, REFLECTION_EVIDENCE_LIMIT);
      if (evidence.length === 0) {
        continue;
      }

      // Relationship arc: quote today's affinity trajectory when it moved.
      const history = state.relationshipHistory(agent.agentId, `${localDay}T00:00:00.000Z`);
      const relationshipArc =
        history.length >= 2 && history[0].affinity !== history[history.length - 1].affinity
          ? `Relationship arc today: your bond with ${state.config.user.displayName} moved from ${history[0].affinity} to ${history[history.length - 1].affinity} (scale -100..100).`
          : undefined;
      const loreQuery = evidence.map((record) => record.content).join("\n");
      const loreHits = retrieveLoreEntries(this.availableSummaryLore(), {
        agentId: agent.agentId,
        text: loreQuery,
        topK: DEFAULT_LORE_RETRIEVAL_TOP_K,
      }).hits;
      const storyContext = this.storyContextFor(state, agent, loreQuery);

      const planner = createLlmReflectionPlanner<RealmMemoryMetadataV1>(llm, {
        personaName: agent.displayName,
        persona: agent.persona,
        ...(relationshipArc !== undefined ? { relationshipArc } : {}),
        loreHits,
        storyContext,
        speakerAliases: dialogueSpeakerAliases(agent.displayName, agent.personaId),
        selfConcept: state.getSelfConceptSnapshot(agent.agentId),
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
      if (state.storyGeneration() !== storyGeneration) {
        notes.push(`${state.config.user.participantId}: reflection discarded after story changed`);
        return written;
      }

      const attemptId = `reflection_${now}_${agent.agentId}`;
      if (reflection.selfConceptProposalError !== undefined) {
        state.appendSelfConceptDecisionAudit(
          agent.agentId,
          attemptId,
          "parse_failure",
          now,
          {
            schemaVersion: SELF_CONCEPT_AUDIT_SCHEMA_VERSION,
            failureClass: reflection.selfConceptProposalError,
          },
        );
        notes.push(`${agent.agentId}: self-concept proposal ${reflection.selfConceptProposalError}`);
      }
      if (reflection.selfConceptProposal !== undefined) {
        state.appendSelfConceptAttemptStarted(
          agent.agentId,
          attemptId,
          reflection.selfConceptProposal.proposalId,
          now,
        );
        const proposalLeak = detectSelfConceptOocLeak(reflection.selfConceptProposal);
        if (proposalLeak !== undefined) {
          state.appendSelfConceptDecisionAudit(
            agent.agentId,
            attemptId,
            "rejected",
            now,
            {
              schemaVersion: SELF_CONCEPT_AUDIT_SCHEMA_VERSION,
              failureClass: `ooc-leak:${proposalLeak}`,
            },
            reflection.selfConceptProposal.proposalId,
          );
          notes.push(`${agent.agentId}: self-concept ooc-leak: ${proposalLeak} (quarantined)`);
        } else {
          const decision = state.applySelfConceptProposal(
            agent.agentId,
            reflection.selfConceptProposal,
            now,
            attemptId,
          );
          if (decision.outcome === "revision_conflict") {
            notes.push(`${agent.agentId}: self-concept revision conflict at ${decision.observedRevision}`);
          } else if (decision.outcome !== "accepted") {
            notes.push(`${agent.agentId}: self-concept ${decision.outcome}`);
          }
        }
      }

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
        // Keep leaked reflection text visible in diagnostics, but out of the
        // evidence stream used by future reflections and conversations.
        const cleanWrites = writes.filter((write) => {
          const leak = detectOocLeak(write.content);
          if (leak === undefined) return true;
          notes.push(`${agent.agentId}: reflection ooc-leak: ${leak} (quarantined)`);
          return false;
        });
        if (cleanWrites.length > 0) {
          state.applyMemoryWrites(agent.agentId, cleanWrites);
          written += cleanWrites.length;
        }
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
    profileId?: string,
  ): AffectState {
    const state = this.stateFor(profileId);
    state.agent(agentId);
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
      state.affectState(agentId) ?? createInitialAffectState(agentId, at, personaBaseline(state.agent(agentId)));
    const proposal: RealmAffectProposalV1 = {
      affect: applyPlotEvents(
        current,
        [event],
        at,
        personaAffectModifiers(state.agent(agentId)),
      ),
      affinityDelta: computeAffinityDelta([event], personaAffectModifiers(state.agent(agentId))),
    };
    state.applyAffectProposal(agentId, proposal, at);
    // The event becomes part of the character's life: a retrievable memory so
    // later conversations can naturally reference it (experience → memory →
    // mention). Manual feeds and scripted plots share this path.
    state.applyMemoryWrites(agentId, [
      {
        id: `plotmem_${at}_${this.eventCounter}`,
        kind: "observation",
        content: this.plotExperienceLine(event, state),
        createdAt: at,
        importance: PLOT_EVENT_MEMORY_IMPORTANCE,
        sourceIds: [event.id],
        visibility: "private",
        tags: [agentId, "plot-event"],
        metadata: {
          source: "engine",
          plotType: event.type,
          plotTarget: event.target,
        },
      },
    ]);
    return proposal.affect;
  }

  /** A natural first-person line describing a plot event as an experience. */
  private plotExperienceLine(event: PlotEvent, state: RealmStateStore): string {
    const label = PLOT_EVENT_LABELS[event.type];
    if (event.target === "host") {
      return `今天和${state.config.user.displayName}之间发生了一件${label}的事。`;
    }
    if (event.target === "self") {
      return `今天经历了一件${label}的事。`;
    }
    return `今天在乐园里经历了一件${label}的事。`;
  }

  /**
   * Give every agent an affect state on first tick, anchored at the
   * character's temperament baseline (ACT fundamental sentiments) so decay
   * regresses toward their own disposition, not a shared default.
   */
  private ensureAffectInitialized(state: RealmStateStore, date: Date): void {
    const now = date.toISOString();
    for (const agent of state.config.agents) {
      if (state.affectState(agent.agentId) === undefined) {
        state.applyAffectProposal(
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
    state: RealmStateStore,
  ): void {
    if (emotion === undefined) {
      return;
    }
    const agent = state.agent(agentId);
    const current =
      state.affectState(agentId) ?? createInitialAffectState(agentId, now, personaBaseline(agent));
    // Emotional expressiveness is a character trait: the blend weight comes
    // from the persona (default 0.1), so composed characters barely move.
    const rate =
      typeof agent.persona === "object" && agent.persona.emotionResponsiveness !== undefined
        ? agent.persona.emotionResponsiveness
        : CONVERSATION_EMOTION_BLEND_RATE;
    state.applyAffectProposal(
      agentId,
      {
        affect: blendConversationEmotion(current, emotion, now, rate),
        affinityDelta: 0,
      },
      now,
    );
  }

  /** Feed each agent's scripted plot events for this period, if configured. */
  private runScriptedPlot(period: RealmRoutinePeriodV1, date: Date, state: RealmStateStore): void {
    for (const agent of state.config.agents) {
      for (const script of agent.plotScript ?? []) {
        if (script.period !== period || script.events.length === 0) {
          continue;
        }
        // Weekday filter: scripts with `days` only fire on those weekdays.
        if (script.days !== undefined && !script.days.includes(date.getDay())) {
          continue;
        }
        for (const event of script.events) {
          this.plotEvent(agent.agentId, event, state.config.user.participantId);
        }
      }
    }
  }

  private runTick(period: RealmRoutinePeriodV1, date: Date, state: RealmStateStore): number {
    const now = date.toISOString();
    // Millisecond timestamp keeps stepIds unique even across restarts within
    // the same hour, so executor-generated memory ids can never collide with
    // records already in the stream.
    const stepId = `step_${date.getTime()}_${period}`;

    const agents = state.config.agents
      .map((agent) => {
        const routine = selectRoutineForPeriod(
          agent.routines,
          period,
          state.affectState(agent.agentId),
          typeof agent.persona === "object" ? agent.persona.personalityDimensions : undefined,
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
          memories: state.memoriesFor(agent.agentId),
          affectState: state.affectState(agent.agentId),
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
      added += state.applyTickMemories(output.agentId, output.memories);
      if (output.affectProposal) {
        state.applyAffectProposal(output.agentId, output.affectProposal, now);
      }
    }
    return added;
  }
}
