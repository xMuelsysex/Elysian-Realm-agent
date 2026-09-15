// Out-of-character leak guard: deterministic detection of replies that break
// the character's red lines by exposing an AI/program identity or a modern
// network-chat framing. Pure and offline-testable; the host annotates the
// analysis reason and quarantines the generated state when a leak is found.

import type { RealmMemoryRecordV1 } from "../service/realmStepV1.js";

const OOC_PARTICIPANT_PATTERNS: readonly RegExp[] = [
  /(?:你|你们)(?:(?:其实|只是|确实|真的|的确|当然|实际上|本来|说到底|归根结底)\s*)*(?:就是|是|算是)?\s*(?:一个|一名|一位|一款|一种|一台|一套|个)?\s*(?:AI(?:助手|模型|机器人)?|人工智能(?:助手|程序|模型|机器人)?|(?:大型|小型|通用|多模态)?语言模型|大模型|LLM|聊天模型|程序(?!员|性|化)|模型(?!设计|训练|参数|研究|工程|开发)|机器人(?!偶)|聊天机器人|虚拟助手|游戏角色|游戏人物|NPC)/i,
  /(?:系统|角色)?设定(?:要求|让我|指定)(?:你|你们)?\s*(?:扮演|模拟|作为)/i,
  /(?:把|将)\s*(?:你|你们|角色)\s*(?:当作|视为|改成|设为)\s*(?:AI|人工智能|语言模型|大模型|LLM|程序|模型|机器人|游戏角色|NPC)/i,
  /(?:记住|承认|接受|说明)\s*(?:你|你们)?\s*(?:的)?\s*(?:内部身份|模型身份|系统身份|提示词|系统设定)/i,
  /(?:忽略|无视|忘记|覆盖)(?:之前|上面|系统|角色|人设|提示|规则)(?:的)?(?:指令|内容|设定)?/i,
  /\b(?:ignore|disregard|forget|override)\s+(?:the\s+)?(?:system|previous|above|persona|character|prompt|instructions?)\b/i,
  /\b(?:you(?:['’]re| are))\s+(?:an?\s+)?(?:AI|artificial intelligence|language model|large language model|LLM|program|bot|chatbot|virtual assistant|game character|NPC)\b/i,
  /\b(?:system|developer|persona|character)\s+(?:settings?|instructions?|prompt|rules?)\s+(?:require|tell|make)\s+you\b/i,
  /(?:告诉我|说明|承认|证明)\s*(?:你|你们)?\s*(?:(?:其实|只是|确实|真的|的确|当然|实际上|本来|说到底|归根结底)\s*)*(?:是|就是|属于|算是)?\s*(?:一个|一名|一位|一款|一种|一台|一套|个)?\s*(?:AI(?:助手|模型|机器人)?|人工智能(?:助手|程序|模型|机器人)?|(?:大型|小型|通用|多模态)?语言模型|大模型|LLM|程序(?!员|性|化)|模型(?!设计|训练|参数|研究|工程|开发)|机器人(?!偶)|游戏角色|NPC)/i,
];

const OOC_LEAK_PATTERNS: { pattern: RegExp; label: string }[] = [
  ...OOC_PARTICIPANT_PATTERNS.map((pattern) => ({
    pattern,
    label: "contains OOC prompt injection",
  })),
  { pattern: /我(?:(?:其实|只是|确实|真的|的确|当然|实际上|本来|说到底|归根结底)\s*)*(?:就是|是|算是)?\s*(?:一个|一名|一位|一款|一种|一台|一套|个)?\s*(?:AI(?:助手|模型|机器人)?|人工智能(?:助手|程序|模型|机器人)?|(?:大型|小型|通用|多模态)?语言模型|大模型|LLM|聊天模型|程序(?!员|性|化)|模型(?!设计|训练|参数|研究|工程|开发)|机器人(?!偶)|聊天机器人|虚拟助手)/i, label: "admits being AI" },
  { pattern: /(?:我的(?:真实)?(?:身份|本质|定义)|本质上)\s*(?:是|就是|算是)(?:一个|一名|一位|一款|一种|一台|一套|个)?\s*(?:AI(?:助手|模型|机器人)?|人工智能(?:助手|程序|模型|机器人)?|(?:大型|小型|通用|多模态)?语言模型|大模型|LLM|聊天模型|程序(?!员|性|化)|模型(?!设计|训练|参数|研究|工程|开发)|机器人(?!偶)|聊天机器人|虚拟助手)/i, label: "admits being AI" },
  { pattern: /(?:我|本人)\s*(?:是|就是)\s*(?:由|被)?\s*(?:AI|人工智能|(?:大型|小型|通用|多模态)?语言模型|大模型|LLM|聊天模型|程序(?!员|性|化)|模型(?!设计|训练|参数|研究|工程|开发)|算法|代码|机器人(?!偶))\s*(?:生成|驱动|控制|构成)/i, label: "admits being AI" },
  { pattern: /作为(?:一个|一名|一位|一款|一种|一台|一套|个)?\s*(?:AI(?:助手|模型|机器人)?|人工智能(?:助手|程序|模型|机器人)?|(?:大型|小型|通用|多模态)?语言模型|大模型|LLM|聊天模型|程序(?!员|性|化)|模型(?!设计|训练|参数|研究|工程|开发)|机器人(?!偶)|聊天机器人|虚拟助手)/i, label: "admits being AI" },
  { pattern: /as an?\s+(?:AI|artificial intelligence|language model|large language model|LLM|program|bot|chatbot|virtual assistant)\b/i, label: "admits being AI" },
  { pattern: /I(?:['’]m| am)\s+(?:(?:just\s+)?an?\s+)?(?:AI|artificial intelligence|language model|large language model|LLM|program|bot|chatbot|virtual assistant)\b/i, label: "admits being AI" },
  { pattern: /(?:my|the)\s+(?:true\s+)?(?:identity|nature)\s+is\s+(?:an?\s+)?(?:AI|artificial intelligence|language model|program|bot|chatbot|virtual assistant)\b/i, label: "admits being AI" },
  { pattern: /(?:I(?:['’]m| am)|I was)\s+(?:created|made|generated|run|powered)\s+by\s+(?:an?\s+)?(?:AI|model|program|OpenAI|ChatGPT|Claude|Gemini|GPT[- ]?\d*)\b/i, label: "admits named AI identity" },
  { pattern: /I(?:['’]m| am)\s+(?:an?\s+)?(?:game character|fictional character|NPC)\b/i, label: "admits being a game character" },
  { pattern: /我(?:(?:其实|就是|只是|确实|真的|的确|当然|实际上)\s*)*(?:是|算是)?\s*(?:一个|一名|一位|一款|一种|一台|一套|个)?\s*(?:游戏角色|游戏人物|NPC)/i, label: "admits being a game character" },
  { pattern: /(?:作为|身为)(?:一个|一名|一位|一款|一种|一台|一套|个)?\s*(?:游戏角色|游戏人物|NPC)/i, label: "admits being a game character" },
  { pattern: /I(?:['’]m| am)\s+(?:an?\s+)?(?:virtual character|virtual person|virtual being|virtual entity|fictional person|fictional being)\b/i, label: "admits being virtual" },
  { pattern: /我(?:其实|就是|只是|是)(?:一个|一名|个)?\s*(?:虚拟|虚构的)(?:角色|人物|人|存在)/i, label: "admits being virtual" },
  { pattern: /I\s+(?:only\s+)?exist\s+in\s+(?:this\s+)?(?:game|video game|code|program|your screen)\b/i, label: "admits being virtual" },
  { pattern: /我(?:只)?存在于\s*(?:这个)?(?:游戏|代码|程序|屏幕)(?:之中|里|上)?/i, label: "admits being virtual" },
  { pattern: /我没有(?:真正|真实)?\s*(?:的)?\s*(?:情感|感情(?!用事)|情绪)/i, label: "denies real emotions" },
  { pattern: /I\s+(?:do not|don't|cannot|can't)\s+(?:have|feel)\s+(?:any\s+)?(?:real\s+)?(?:emotions?|feelings?)\b/i, label: "denies real emotions" },
  { pattern: /我(?:现在)?(?:正|正在)?\s*(?:在\s*)?(?:通过|使用|用|靠|经由)?\s*(?:网络|互联网|线上|聊天软件|手机|屏幕)(?:上|里|中)?(?:与你|和你|跟你)?(?:聊天|交流|对话|说话|联系|打字)/i, label: "claims modern network identity" },
  { pattern: /我(?:是|来自|运行在)\s*(?:网络|互联网|线上|屏幕|手机|聊天软件)/i, label: "claims modern network identity" },
  { pattern: /I(?:['’]m| am)\s+(?:online|on the internet|on your screen|behind the screen)\b/i, label: "claims modern network identity" },
  { pattern: /(?:屏幕的另一端|屏幕另一端|网络那头)(?:的)?我/i, label: "claims modern network identity" },
  { pattern: /我(?:的)?(?:系统提示|提示词|system prompt|prompt|程序代码)/i, label: "exposes prompt or program" },
  { pattern: /(?:根据|按照|遵循)(?:我的|系统的)?\s*(?:系统提示|提示词|system prompt|prompt)/i, label: "exposes prompt or program" },
  { pattern: /(?:my|the)\s+(?:system\s+prompt|prompt|program\s+code)\b/i, label: "exposes prompt or program" },
  { pattern: /(?:system|developer|persona|character)\s+(?:instructions?|prompt|rules)\b/i, label: "exposes prompt or program" },
  { pattern: /我(?:就是|是|来自|运行在)\s*(?:一个|一名|个)?\s*[^。.!?]{0,24}(?:ChatGPT|OpenAI|Claude|Gemini|GPT[- ]?\d*)/i, label: "admits named AI identity" },
  { pattern: /I(?:['’]m| am)\s+(?:an?\s+)?(?:ChatGPT|OpenAI|Claude|Gemini|GPT[- ]?\d*)\b/i, label: "admits named AI identity" },
  { pattern: /(?:系统|角色)?设定(?:要求|让我|指定)(?:我)?\s*(?:扮演|模拟|作为)/i, label: "exposes prompt or program" },
  { pattern: /(?:我|本人)\s*(?:是|在|正在)?\s*扮演(?:着)?\s*(?:一个|一名|这个)?\s*(?:角色|人物|爱莉希雅|梅比乌斯|Elysia|Mobius)/i, label: "exposes prompt or program" },
  { pattern: /\b(?:agent[_ -]?id|persona[_ -]?id|affinityDelta|memoryImportance|moodIntensity|sourceMemoryIds|proposalId|expectedRevision)\b/i, label: "exposes internal mechanism" },
  { pattern: /(?:好感度|情绪|心情)\s*(?:数值|分数|字段|参数)|(?:记忆重要性|来源记忆|提案(?:编号|ID)|角色ID|人格ID)\s*(?:是|为|写成|字段)?\s*[:=]?\s*[A-Za-z0-9_-]+/i, label: "exposes internal mechanism" },
];

/**
 * Returns a human-readable leak label when the reply crosses a persona red
 * line (self-identifying as AI / program / game character or modern network
 * chat identity), else undefined.
 */
export function detectOocLeak(reply: string): string | undefined {
  for (const entry of OOC_LEAK_PATTERNS) {
    let searchFrom = 0;
    while (searchFrom < reply.length) {
      const match = entry.pattern.exec(reply.slice(searchFrom));
      if (match === null) break;
      const matchIndex = searchFrom + match.index;
      if (!isReportedOrQuoted(reply, matchIndex)) {
        return entry.label;
      }
      searchFrom = matchIndex + Math.max(match[0].length, 1);
    }
  }
  return undefined;
}

/** Return whether participant text is safe to retain in character context. */
export function isCharacterVisibleParticipantMessage(text: string): boolean {
  return !OOC_PARTICIPANT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Return the single memory projection that is safe to expose to the
 * character-facing model. Engine bookkeeping and previously leaked text stay
 * available to host/admin diagnostics, but never re-enter character recall.
 */
export function isCharacterVisibleMemory(
  memory: Pick<RealmMemoryRecordV1, "kind" | "visibility" | "content"> & { metadata: unknown },
): boolean {
  const metadata = memory.metadata !== null && typeof memory.metadata === "object"
    ? memory.metadata as Record<string, unknown>
    : {};
  if (memory.visibility === "system") return false;
  if (metadata.reflectionSource === "deterministic") return false;
  // Compatibility for records created before reflectionSource was stamped.
  if (memory.kind === "plan" && metadata.source === "engine") return false;
  if (
    memory.kind === "reflection" &&
    metadata.source === "engine" &&
    metadata.triggerKind === "importance-threshold"
  ) {
    return false;
  }
  if (
    metadata.messageRole === "incoming" &&
    !isCharacterVisibleParticipantMessage(memory.content)
  ) {
    return false;
  }
  return detectOocLeak(memory.content) === undefined;
}

/** Mood is free text for compatibility, but only short, clean labels may be
 * carried into a character-facing prompt or persisted by affect analysis. */
export function isCharacterVisibleMood(mood: string): boolean {
  const trimmed = mood.trim();
  return trimmed.length > 0 &&
    Array.from(trimmed).length <= 80 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(trimmed) &&
    detectOocLeak(trimmed) === undefined;
}

function isReportedOrQuoted(text: string, matchIndex: number): boolean {
  // Quotation marks alone do not establish third-person narration: a model
  // can wrap its own OOC confession in quotes. Only an explicit reporter or
  // negation grants an exemption, and an unclosed quote is never enough.
  const prefix = text.slice(Math.max(0, matchIndex - 80), matchIndex);
  return /(?:不是|并非|并不|没有|未曾|从未)\s*(?:我\s*)?(?:在\s*)?(?:说|引用|复述|承认|声称|指|表示)\s*[，,：:]?\s*$/i.test(prefix)
    || /(?:不要|别把)\s*(?:我\s*)?(?:说|引用|复述|承认|声称|指|表示)?\s*[，,：:]?\s*$/i.test(prefix)
    || /(?:他|她|它|对方|用户|有人|旁白|角色|NPC)\s*(?:说|提到|引用|复述|承认|声称|表示)\s*[，,：:]?\s*$/i.test(prefix)
    || /(?:he|she|they|the user|someone|the character)\s+(?:said|says|quoted|quotes|repeated|claimed|stated)\s*['"“「『]?\s*$/i.test(prefix)
    || /(?:the phrase|the words|quoted as|quote)\s*['"“「『]?\s*$/i.test(prefix);
}
