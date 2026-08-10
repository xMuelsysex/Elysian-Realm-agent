#!/bin/bash
set -euo pipefail

# 角色保真度评分：对固定场景构造 system prompt，检查注入要素完整度。
# 场景与要素清单固定于 .auto/fidelity-scenarios.json（measure 只读，防实现过拟合）。
# 顺序：先 npm test（含 build，保证 dist 新鲜），再评分。

cd "$(dirname "$0")/.."

TEST_OUT=$(npm test 2>&1 || true)
TESTS=$(printf '%s\n' "$TEST_OUT" | grep -oE 'pass [0-9]+' | grep -oE '[0-9]+' | tail -1 || true)
echo "METRIC tests=${TESTS:-0}"

node --input-type=module -e '
import { readFileSync } from "node:fs";
import { buildConversationSystemPrompt } from "./dist/conversation/conversationPrompt.js";

const scenarios = JSON.parse(readFileSync(".auto/fidelity-scenarios.json", "utf8"));

let total = 0;
let earned = 0;
let bytes = 0;
for (const s of scenarios) {
  const prompt = buildConversationSystemPrompt(s.input);
  bytes += Buffer.byteLength(prompt, "utf8");
  for (const el of s.elements) {
    total += el.weight;
    if (prompt.includes(el.needle)) earned += el.weight;
  }
}
const score = total === 0 ? 0 : Math.round((earned / total) * 100);
console.log(`METRIC character_fidelity=${score}`);
console.log(`METRIC prompt_bytes=${bytes}`);
' 2>&1
