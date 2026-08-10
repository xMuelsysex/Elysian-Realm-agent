// Chat page: dependency-free single file served at GET /chat. Bubbles, an
// affinity/mood badge that updates after every exchange, and an agent picker
// when the realm has more than one persona.
//
// Shared constants (plot event types + labels, prominent-emotion threshold)
// come from the backend modules so the page cannot drift from the engine.

import { EMOTION_LABELS, PLOT_EVENT_LABELS, PLOT_EVENT_TYPES } from "../affect/affectRecords.js";
import { PROMINENT_EMOTION_MIN_STRENGTH } from "../conversation/conversationPrompt.js";

const PLOT_TYPES_JSON = JSON.stringify(
  PLOT_EVENT_TYPES.map((type) => [type, PLOT_EVENT_LABELS[type]] as const),
);
const EMOTION_LABELS_JSON = JSON.stringify(EMOTION_LABELS);

export const CHAT_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Elysian Realm — 聊天</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; max-width: 44rem; margin: 0 auto; padding: 0 1rem; height: 100dvh; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: .75rem; padding: .9rem 0; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
  header h1 { font-size: 1.05rem; margin: 0; flex: 1; }
  #agentPicker { font: inherit; padding: .3rem .5rem; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: transparent; color: inherit; }
  #badge { font-size: .82rem; opacity: .85; text-align: right; line-height: 1.4; white-space: nowrap; }
  #log { flex: 1; overflow-y: auto; padding: 1rem 0; display: flex; flex-direction: column; gap: .6rem; }
  .bubble { max-width: 78%; padding: .55rem .85rem; border-radius: 14px; white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
  .error-detail { margin-top: .3rem; font-size: .72em; opacity: .55; white-space: pre-wrap; }
  .agent { align-self: flex-start; background: color-mix(in srgb, currentColor 10%, transparent); border-bottom-left-radius: 4px; }
  .user { align-self: flex-end; background: color-mix(in srgb, #4dabf7 22%, transparent); border-bottom-right-radius: 4px; }
  .sys { align-self: center; font-size: .8rem; opacity: .65; }
  #plotForm { display: flex; gap: .6rem; padding: .6rem 0 0; align-items: center; }
  #plotForm select, #plotForm button { font: inherit; font-size: .85rem; }
  #plotForm label { font-size: .8rem; opacity: .7; }
  form { display: flex; gap: .6rem; padding: .8rem 0 1rem; border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
  #input { flex: 1; font: inherit; padding: .55rem .8rem; border-radius: 10px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: transparent; color: inherit; }
  button { font: inherit; padding: .55rem 1.2rem; border-radius: 10px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: transparent; color: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: wait; }
</style>
</head>
<body>
<header>
  <h1 id="title">Elysian Realm</h1>
  <select id="agentPicker" hidden></select>
  <div id="badge">加载中…</div>
</header>
<div id="log"></div>
<form id="plotForm">
  <label for="plotType">剧情</label>
  <select id="plotType"></select>
  <button id="plotSend" type="submit">投喂</button>
</form>
<form id="form">
  <input id="input" autocomplete="off" placeholder="说点什么…">
  <button id="send" type="submit">发送</button>
</form>
<script>
const $ = (id) => document.getElementById(id);
let agents = [];
let current = null;

const PLOT_TYPES = __PLOT_TYPES__;
const EMOTION_LABELS = __EMOTION_LABELS__;
const EMOTION_MIN_STRENGTH = __EMOTION_MIN_STRENGTH__;

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function heart(affinity) {
  if (affinity >= 75) return "💗";
  if (affinity >= 40) return "💕";
  if (affinity >= 15) return "🩷";
  if (affinity > -15) return "🤍";
  return "💔";
}

function renderBadge(agent) {
  const moodText = agent.mood ? \`\${agent.mood.mood}\` : "平静";
  const emotionText = agent.affect ? topEmotions(agent.affect) : "—";
  $("badge").innerHTML = \`\${heart(agent.affinity)} 好感 \${agent.affinity}<br>心情 \${moodText}<br>情绪 \${emotionText}\`;
}

function topEmotions(affect, limit = 2) {
  return Object.entries(affect.emotionLabels)
    .filter(([label, strength]) => label !== "neutral" && strength >= EMOTION_MIN_STRENGTH)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, strength]) => \`\${label} \${Number(strength).toFixed(2)}\`)
    .join(" / ") || "平稳";
}

function bubble(cls, text) {
  const el = document.createElement("div");
  el.className = "bubble " + cls;
  el.textContent = text;
  $("log").appendChild(el);
  $("log").scrollTop = $("log").scrollHeight;
  return el;
}

// Map raw transport errors to friendly copy while keeping the detail visible
// on a dim second line — the user's LLM relay may be down or rate-limited.
function bubbleError(raw) {
  const text = String(raw ?? "");
  const status = Number(text.match(/\\b([45]\\d{2})\\b/)?.[1] ?? 0);
  let head;
  if (status >= 500) head = "爱莉希雅暂时联系不上 LLM 服务，请稍后再试～";
  else if (status === 429) head = "请求太频繁啦，稍等一会儿再试喵～";
  else if (status >= 400) head = "请求被拒绝了（HTTP " + status + "），检查一下配置喵？";
  else head = "和爱莉希雅的连接出了点问题，请稍后再试～";
  const el = bubble("sys", head);
  if (text && text !== head) {
    const detail = document.createElement("div");
    detail.className = "error-detail";
    detail.textContent = text;
    el.appendChild(detail);
  }
  return el;
}

async function loadAgent(agent) {
  current = agent;
  $("title").textContent = agent.displayName;
  renderBadge(agent);
  $("log").innerHTML = "";
  const { body } = await api("/v1/host/history/" + encodeURIComponent(agent.agentId));
  for (const turn of body.turns ?? []) {
    bubble(turn.role === "agent" ? "agent" : "user", turn.content);
  }
  if ((body.turns ?? []).length === 0) {
    bubble("sys", \`和\${agent.displayName}的故事从这里开始～\`);
  }
}

async function init() {
  const { body } = await api("/v1/host/state");
  agents = body.agents ?? [];
  if (agents.length === 0) {
    $("badge").textContent = "没有配置角色";
    return;
  }
  if (agents.length > 1) {
    const picker = $("agentPicker");
    picker.hidden = false;
    picker.innerHTML = agents
      .map((agent) => \`<option value="\${agent.agentId}">\${agent.displayName}</option>\`)
      .join("");
    picker.addEventListener("change", () => {
      const agent = agents.find((entry) => entry.agentId === picker.value);
      if (agent) void loadAgent(agent);
    });
  }
  const plotType = $("plotType");
  plotType.innerHTML = PLOT_TYPES
    .map(([value, label]) => \`<option value="\${value}">\${label}</option>\`)
    .join("");
  await loadAgent(agents[0]);
}

$("plotForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!current) return;
  $("plotSend").disabled = true;
  const { status, body } = await api("/v1/host/plot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: current.agentId, type: $("plotType").value, target: "host", intensity: 1 }),
  });
  $("plotSend").disabled = false;
  if (status === 200) {
    current.affect = body.affect;
    bubble("sys", \`剧情投喂：\${$("plotType").selectedOptions[0].text} → \${topEmotions(body.affect)}\`);
    renderBadge(current);
  } else {
    bubble("sys", body.error?.message ?? \`投喂失败 (HTTP \${status})\`);
  }
});

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!current) return;
  const content = $("input").value.trim();
  if (content.length === 0) return;

  $("input").value = "";
  $("send").disabled = true;
  bubble("user", content);
  const pending = bubble("sys", \`\${current.displayName}正在输入…\`);

  try {
    const response = await fetch("/v1/host/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: current.agentId, content, stream: true }),
    });
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("text/event-stream")) {
      // SSE: deltas fill the pending bubble, "done" unlocks input the moment
      // the reply completes, "applied" carries the final affinity/mood.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let started = false;
      let done = false;
      let applied = null;
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let frameEnd;
        while ((frameEnd = buffer.indexOf("\\n\\n")) !== -1) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          const dataLine = frame.split("\\n").find((line) => line.startsWith("data:"));
          if (!dataLine) continue;
          const event = frame
            .split("\\n")
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim() ?? "message";
          const data = JSON.parse(dataLine.slice(5).trim());
          if (event === "delta") {
            pending.textContent = started ? pending.textContent + data.text : data.text;
            started = true;
          } else if (event === "done") {
            // Reply complete: the pending bubble already carries the text —
            // restyle it as the agent bubble and unlock input immediately.
            pending.className = "bubble agent";
            done = true;
          } else if (event === "applied") {
            applied = data;
          } else if (event === "error") {
            throw new Error(data.message);
          }
        }
      }
      // The pending bubble was restyled into the agent bubble on "done";
      // only remove it when the reply never arrived.
      if (!done) {
        pending.remove();
      }
      if (applied) {
        current.affinity = applied.affinity;
        current.mood = applied.mood;
        renderBadge(current);
        // OOC red-line leaks surface visibly (analysisReason is annotated by
        // the host with "ooc-leak: ..." when the reply broke character).
        if (applied.analysisReason && String(applied.analysisReason).includes("ooc-leak")) {
          bubble("sys", "⚠️ " + String(applied.analysisReason));
        }
      } else if (!done) {
        bubble("sys", "流式对话未收到完成事件");
      }
    } else {
      // JSON fallback for hosts without streaming.
      const body = await response.json().catch(() => ({}));
      pending.remove();
      if (response.status === 200) {
        bubble("agent", body.reply);
        current.affinity = body.affinity;
        current.mood = body.mood;
        renderBadge(current);
        if (body.analysisReason && String(body.analysisReason).includes("ooc-leak")) {
          bubble("sys", "⚠️ " + String(body.analysisReason));
        }
      } else {
        bubble("sys", body.error?.message ?? \`发送失败 (HTTP \${response.status})\`);
      }
    }
  } catch (error) {
    pending.remove();
    bubbleError(error instanceof Error ? error.message : error);
  } finally {
    $("send").disabled = false;
    $("input").focus();
  }
});

init().catch((error) => bubbleError(error instanceof Error ? error.message : error));
</script>
</body>
</html>
`
  .replaceAll("__PLOT_TYPES__", PLOT_TYPES_JSON)
  .replaceAll("__EMOTION_LABELS__", EMOTION_LABELS_JSON)
  .replaceAll("__EMOTION_MIN_STRENGTH__", String(PROMINENT_EMOTION_MIN_STRENGTH));
