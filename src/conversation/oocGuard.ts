// Out-of-character leak guard: deterministic detection of replies that break
// the character's red lines by admitting to being an AI / program / game.
// Pure and offline-testable; the host annotates the analysis reason so the
// leak stays visible instead of silently passing.

const OOC_LEAK_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /我是(?:一个)?(?:AI|人工智能|程序|模型|机器人)/i, label: "admits being AI" },
  { pattern: /作为(?:一个)?(?:AI|人工智能|语言模型|程序|机器人)/i, label: "admits being AI" },
  { pattern: /as an? (?:AI|artificial intelligence|language model|program|bot)/i, label: "admits being AI" },
  { pattern: /I(?:'m| am) (?:an? )?(?:AI|artificial intelligence|language model|program|bot)/i, label: "admits being AI" },
  { pattern: /我(?:是|只是)个?游戏(?:角色|npc)/i, label: "admits being a game character" },
  { pattern: /我(?:是|只是)(?:个)?虚拟(?:角色|人|存在)/i, label: "admits being virtual" },
  { pattern: /我没有(?:真实)?(?:情感|感情|情绪)/i, label: "denies real emotions" },
  { pattern: /I(?:'m| am) just an? (?:AI|bot|virtual assistant)/i, label: "admits being AI" },
  { pattern: /说实话[，,]?我是AI/i, label: "admits being AI" },
];

/**
 * Returns a human-readable leak label when the reply crosses a persona red
 * line (self-identifying as AI / program / game character), else undefined.
 */
export function detectOocLeak(reply: string): string | undefined {
  for (const entry of OOC_LEAK_PATTERNS) {
    if (entry.pattern.test(reply)) {
      return entry.label;
    }
  }
  return undefined;
}
