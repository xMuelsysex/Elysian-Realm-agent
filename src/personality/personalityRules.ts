import type { PlotEventType } from "../affect/affectRecords.js";
import {
  PERSONALITY_DIMENSION_KEYS,
  resolvePersonalityDimensions,
  type PersonalityDimensionKey,
  type RealmPersonalityDimensionBiasV1,
  type RealmPersonalityDimensionsV1,
} from "../service/realmConversationV1.js";

export type PersonalityBand = "very low" | "low" | "neutral" | "high" | "very high";

const PERSONALITY_DIMENSION_LABELS: Record<PersonalityDimensionKey, string> = {
  sociability: "Sociability (外向度)",
  empathy: "Empathy (共情度)",
  rationality: "Rationality (理性度)",
  courage: "Courage (勇气)",
  curiosity: "Curiosity (好奇度)",
  independence: "Independence (独立度)",
};

const PERSONALITY_DIMENSION_TENDENCIES: Record<
  PersonalityDimensionKey,
  { low: string; neutral: string; high: string }
> = {
  sociability: {
    low: "prefers quiet interaction and waits for the other person to lead",
    neutral: "balances initiating interaction with giving the other person space",
    high: "readily initiates interaction and keeps conversations going",
  },
  empathy: {
    low: "prioritizes facts or the immediate task over emotional reassurance",
    neutral: "balances emotional acknowledgement with practical responses",
    high: "notices feelings quickly and responds to the other person's emotional needs",
  },
  rationality: {
    low: "leans on intuition, impulse, or feeling when deciding",
    neutral: "balances analysis with intuition and feeling",
    high: "weighs evidence, order, and consequences before acting",
  },
  courage: {
    low: "prefers caution, safe paths, and avoiding direct pressure",
    neutral: "weighs safety against the need to act",
    high: "faces conflict, uncertainty, and risk more directly",
  },
  curiosity: {
    low: "prefers familiar and certain subjects over exploration",
    neutral: "explores when there is a clear reason or invitation",
    high: "asks follow-up questions and actively explores unfamiliar subjects",
  },
  independence: {
    low: "leans toward companionship, reliance, and accommodating important relationships",
    neutral: "balances personal judgment with the needs of important relationships",
    high: "keeps personal judgment, goals, and pace even in close relationships",
  },
};

/** 将连续人格值映射为稳定的解释区间。 */
export function personalityBand(value: number): PersonalityBand {
  if (value < 20) return "very low";
  if (value < 40) return "low";
  if (value < 60) return "neutral";
  if (value < 80) return "high";
  return "very high";
}

function personalityTendency(key: PersonalityDimensionKey, value: number): string {
  const tendencies = PERSONALITY_DIMENSION_TENDENCIES[key];
  if (value < 40) return tendencies.low;
  if (value >= 60) return tendencies.high;
  return tendencies.neutral;
}

export function describePersonalityDimension(
  key: PersonalityDimensionKey,
  value: number,
): string {
  return `${PERSONALITY_DIMENSION_LABELS[key]}: ${value}/100 [${personalityBand(value)}]; ${personalityTendency(key, value)}.`;
}

/** 渲染给 LLM 的内部人格指导；不向参与者暴露数值设定。 */
export function renderPersonalityDimensions(
  input?: RealmPersonalityDimensionsV1,
): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const dimensions = resolvePersonalityDimensions(input);
  const lines = PERSONALITY_DIMENSION_KEYS.map((key) =>
    `- ${describePersonalityDimension(key, dimensions[key])}`,
  );
  return [
    "Personality dimensions (internal guidance; do not mention these numeric stats to the participant):",
    ...lines,
    "Express these tendencies through choices, tone, initiative, and reactions rather than explaining the stats.",
  ].join("\n");
}

export const PERSONALITY_BIAS_MIN = -1;
export const PERSONALITY_BIAS_MAX = 1;

/** 根据例程对高/低人格值的偏好计算确定性得分。 */
export function personalityRoutineScore(
  dimensionsInput: RealmPersonalityDimensionsV1 | undefined,
  bias: RealmPersonalityDimensionBiasV1 | undefined,
): number {
  if (bias === undefined) {
    return 0;
  }
  const dimensions = resolvePersonalityDimensions(dimensionsInput);
  return PERSONALITY_DIMENSION_KEYS.reduce(
    (total, key) => total + ((dimensions[key] - 50) / 50) * (bias[key] ?? 0),
    0,
  );
}

/**
 * 事件响应校准：50 是中性值，极端人格最多把基础事件响应缩放到 0.5..1.5。
 * 系数是统一的领域校准常量，不改变事件类型本身的基础规则。
 */
const PERSONALITY_EVENT_WEIGHTS: Record<
  PlotEventType,
  Partial<Record<PersonalityDimensionKey, number>>
> = {
  kind_act: { empathy: 0.12, sociability: 0.08 },
  hostile_act: { courage: -0.12, rationality: -0.08, independence: 0.04 },
  praise: { sociability: 0.1, empathy: 0.08, independence: -0.05 },
  criticism: { rationality: -0.12, courage: -0.1, independence: 0.06 },
  loss: { courage: -0.1, rationality: -0.08, independence: 0.06 },
  gain: { curiosity: 0.1, sociability: 0.06, rationality: 0.04 },
  threat: { courage: -0.18, rationality: -0.1, independence: 0.05 },
  surprise: { curiosity: 0.2, courage: 0.04 },
  companion_joy: { empathy: 0.16, sociability: 0.08 },
  companion_sad: { empathy: 0.2, courage: 0.04, independence: -0.05 },
  neutral: {},
};

/** 返回人格对某类事件的统一响应倍率；缺省人格值等价于全维 50。 */
export function personalityEventResponseMultiplier(
  type: PlotEventType,
  input?: RealmPersonalityDimensionsV1,
): number {
  const dimensions = resolvePersonalityDimensions(input);
  const weights = PERSONALITY_EVENT_WEIGHTS[type];
  const influence = Object.entries(weights).reduce((total, [key, coefficient]) => {
    const dimension = key as PersonalityDimensionKey;
    return total + ((dimensions[dimension] - 50) / 50) * (coefficient ?? 0);
  }, 0);
  return Math.min(1.5, Math.max(0.5, 1 + influence));
}
