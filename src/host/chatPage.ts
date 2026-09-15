// Chat page: dependency-free single file served at GET /chat. Bubbles with
// speaker avatars, an affinity/mood badge that updates after every exchange, a
// "new conversation" control, and an agent picker when the realm has more than
// one persona.
//
// Shared constants (plot event types + labels, prominent-emotion threshold)
// come from the backend modules so the page cannot drift from the engine.

import { EMOTION_LABELS, PLOT_EVENT_LABELS, PLOT_EVENT_TYPES } from "../affect/affectRecords.js";
import { PROMINENT_EMOTION_MIN_STRENGTH } from "../conversation/conversationPrompt.js";
import { PERSONA_AVATARS } from "./avatarAssets.js";

const PLOT_TYPES_JSON = JSON.stringify(
  PLOT_EVENT_TYPES.map((type) => [type, PLOT_EVENT_LABELS[type]] as const),
);
const EMOTION_LABELS_JSON = JSON.stringify(EMOTION_LABELS);
const AVATARS_JSON = JSON.stringify(PERSONA_AVATARS);

export const CHAT_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Elysian Realm — 聊天</title>
<style>
  /* Pin the light scheme and paint the page ourselves: an unpainted page keeps
     the host window's white backdrop while the text color can resolve to the
     dark scheme's white — white on white for the page and for the native
     dropdown popup, whose text follows the same color. */
  html { color-scheme: only light; background: #fff; color: #1a1a1a; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; max-width: 88rem; margin: 0 auto; padding: 0 .75rem; height: 100dvh; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: .75rem; padding: .9rem 0; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
  header h1 { font-size: 1.05rem; margin: 0; flex: 1; }
  /* Controls carry their own surface: a transparent background merges into the
     page (and into a native dialog's background), which reads as no control. */
  #profilePicker, #agentPicker, #plotType { font: inherit; padding: .3rem .5rem; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); background: color-mix(in srgb, currentColor 8%, transparent); color: inherit; }
  #profilePicker, #agentPicker { max-width: 10rem; }
  #badge { font-size: .82rem; opacity: .85; text-align: right; line-height: 1.4; white-space: nowrap; }
  #settingsLink, #testLink, #newChat { color: inherit; text-decoration: none; padding: .3rem .55rem; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); border-radius: 6px; background: color-mix(in srgb, currentColor 8%, transparent); white-space: nowrap; }
  #settingsLink:hover, #testLink:hover, #newChat:hover { background: color-mix(in srgb, currentColor 18%, transparent); }
  #newChat:disabled { opacity: .5; cursor: wait; }
  #storyBanner { padding: .65rem .8rem; margin: .75rem 0 0; border: 1px solid color-mix(in srgb, #4dabf7 35%, transparent); border-radius: 8px; background: color-mix(in srgb, #4dabf7 8%, transparent); }
  #storyBanner strong { display: block; font-size: .9rem; }
  #storyBanner a { color: inherit; }
  #layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(17rem, 22rem); gap: 1rem; }
  #chatColumn { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  #storyPanel { min-width: 0; min-height: 0; overflow-y: auto; padding: .75rem 0 1rem; }
  #storyDetails { border: 1px solid color-mix(in srgb, #4dabf7 35%, transparent); border-radius: 10px; background: color-mix(in srgb, #4dabf7 6%, transparent); }
  #storyDetails > summary { display: flex; align-items: center; gap: .5rem; padding: .75rem .85rem; cursor: pointer; list-style: none; }
  #storyDetails > summary::-webkit-details-marker { display: none; }
  #storyDetails > summary::after { content: "⌄"; margin-left: auto; opacity: .65; }
  #storyDetails:not([open]) > summary::after { content: "›"; }
  #storyPanelMeta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .78rem; opacity: .7; }
  #storyPanelBody { padding: 0 .85rem .85rem; }
  #storyPanelBody h3 { margin: .85rem 0 .35rem; font-size: .82rem; }
  #storyPanelBody p { margin: 0; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
  #storyRecap { display: flex; flex-direction: column; gap: .65rem; padding-left: 1.2rem; margin: 0; }
  #storyRecap li { padding-left: .15rem; line-height: 1.45; }
  .story-recap-title { display: block; font-size: .8rem; opacity: .75; }
  #storyQuestions { display: flex; flex-direction: column; gap: .45rem; }
  #storyQuestions button { padding: .45rem .6rem; text-align: left; line-height: 1.4; }
  .story-error { color: #d66; }
  #log { flex: 1; min-height: 0; overflow-y: auto; padding: 1rem 0; display: flex; flex-direction: column; gap: .6rem; }
  .row { display: flex; align-items: flex-end; gap: .55rem; }
  .row.sys { justify-content: center; }
  .row.user { flex-direction: row-reverse; }
  .avatar { flex: 0 0 auto; width: 2.75rem; height: 2.75rem; border-radius: 50%; object-fit: contain; background: color-mix(in srgb, currentColor 8%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 25%, transparent); }
  .avatar-text { display: flex; align-items: center; justify-content: center; font-size: 1rem; font-weight: 600; color: #fff; }
  .bubble { max-width: 78%; padding: .55rem .85rem; border-radius: 14px; white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
  .error-detail { margin-top: .3rem; font-size: .72em; opacity: .55; white-space: pre-wrap; }
  .bubble.agent { background: color-mix(in srgb, currentColor 10%, transparent); border-bottom-left-radius: 4px; }
  .bubble.user { background: color-mix(in srgb, #4dabf7 22%, transparent); border-bottom-right-radius: 4px; }
  .sys { font-size: .8rem; opacity: .65; }
  #plotForm { display: flex; gap: .6rem; padding: .6rem 0 0; align-items: center; }
  #plotForm select, #plotForm button { font: inherit; font-size: .85rem; }
  #plotForm label { font-size: .8rem; opacity: .7; }
  form { display: flex; gap: .6rem; padding: .8rem 0 1rem; border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
  #input { flex: 1; font: inherit; padding: .55rem .8rem; border-radius: 10px; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); background: color-mix(in srgb, currentColor 8%, transparent); color: inherit; }
  button { font: inherit; padding: .55rem 1.2rem; border-radius: 10px; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); background: color-mix(in srgb, currentColor 8%, transparent); color: inherit; cursor: pointer; }
  button:hover { background: color-mix(in srgb, currentColor 18%, transparent); }
  button:disabled { opacity: .5; cursor: wait; }
  #confirm { position: fixed; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center; padding: 1rem; background: color-mix(in srgb, #000 45%, transparent); }
  #confirm[hidden] { display: none; }
  #confirmCard { width: 100%; max-width: 26rem; padding: 1.1rem 1.2rem; border-radius: 12px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: Canvas; color: CanvasText; box-shadow: 0 12px 40px color-mix(in srgb, #000 45%, transparent); }
  #confirmText { margin: 0; line-height: 1.6; }
  #confirmActions { display: flex; justify-content: flex-end; gap: .6rem; margin-top: 1.1rem; }
  #confirmActions button { padding: .5rem 1rem; }
  #confirmOk { background: #e03131; border-color: #e03131; color: #fff; }
  #confirmOk:hover { background: #c92a2a; }
  #confirmOk:disabled { opacity: .5; }
  @media (max-width: 760px) {
    body { max-width: 44rem; }
    header { flex-wrap: wrap; row-gap: .5rem; }
    header h1 { flex: 1 1 100%; }
    #layout { display: flex; flex-direction: column; overflow: hidden; }
    #chatColumn { flex: 1; }
    #storyPanel { flex: 0 0 auto; max-height: 30dvh; padding-top: 0; }
  }
</style>
</head>
<body>
<header>
  <h1 id="title">Elysian Realm</h1>
  <a id="settingsLink" href="/admin" title="配置 LLM 与用户档案" aria-label="打开 LLM 与用户档案设置">⚙ 设置</a>
  <a id="testLink" href="/test" title="查看模型与剧情上下文" aria-label="打开剧情测试台">🧪 测试</a>
  <button id="newChat" type="button" title="开始新的对话" aria-label="开始新的对话">＋ 新对话</button>
  <select id="profilePicker" hidden aria-label="选择用户档案"></select>
  <select id="agentPicker" hidden aria-label="选择角色"></select>
  <div id="badge">加载中…</div>
</header>
<div id="layout">
  <main id="chatColumn">
    <div id="storyBanner" hidden aria-live="polite"></div>
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
  </main>
  <aside id="storyPanel" hidden aria-live="polite">
    <details id="storyDetails" open>
      <summary><strong>📖 当前剧情</strong><span id="storyPanelMeta"></span></summary>
      <div id="storyPanelBody"></div>
    </details>
  </aside>
</div>
<div id="confirm" hidden role="dialog" aria-modal="true" aria-labelledby="confirmText">
  <div id="confirmCard">
    <p id="confirmText"></p>
    <div id="confirmActions">
      <button id="confirmCancel" type="button">取消</button>
      <button id="confirmOk" type="button">确定</button>
    </div>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
let profiles = [];
let activeProfileId = null;
let agents = [];
let current = null;
let currentStory = null;
let viewGeneration = 0;
let viewLoading = false;

const PLOT_TYPES = __PLOT_TYPES__;
const EMOTION_LABELS = __EMOTION_LABELS__;
const EMOTION_MIN_STRENGTH = __EMOTION_MIN_STRENGTH__;
const AVATARS = __AVATARS__;

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

function appendText(parent, tag, className, text) {
  const child = document.createElement(tag);
  if (className) child.className = className;
  child.textContent = String(text);
  parent.appendChild(child);
  return child;
}

function renderStory(story) {
  const banner = $("storyBanner");
  banner.replaceChildren();
  const cursor = Number(story?.cursor ?? 0);
  if (!story || cursor <= 0) {
    appendText(banner, "strong", "", "当前剧情尚未解锁");
    const link = document.createElement("a");
    link.href = "/admin";
    link.textContent = "前往设置推进剧情";
    banner.appendChild(link);
    appendText(banner, "div", "muted", "角色会在已解锁并符合自身入场点的范围内回应");
    banner.hidden = false;
    return;
  }

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const scene = scenes.find((entry) => Number(entry.order) + 1 === cursor);
  const chapter = (story.chapters ?? []).find((entry) => entry.id === scene?.chapterId);
  appendText(banner, "strong", "", "当前剧情 · " + (chapter?.title ?? "剧情").trim());
  appendText(banner, "div", "", "场景 " + cursor + " · " + (scene?.title ?? "当前场景"));
  let detail = "已解锁 " + cursor + " / " + Number(story.totalScenes ?? scenes.length) + " 个场景 · 角色会依据当前阶段和入场点回应";
  if (scene?.available === false) detail += " · 当前源页面缺失";
  appendText(banner, "div", "muted", detail);
  banner.hidden = false;
}

function renderStoryOverviewState(message, className = "muted") {
  $("storyPanel").hidden = false;
  $("storyPanelMeta").textContent = "";
  const body = $("storyPanelBody");
  body.replaceChildren();
  appendText(body, "div", className, message);
}

function renderStoryOverview(data) {
  const panel = $("storyPanel");
  panel.hidden = false;
  const currentScene = data.currentScene;
  $("storyPanelMeta").textContent = currentScene
    ? currentScene.chapterTitle + " · " + currentScene.title
    : "";
  const body = $("storyPanelBody");
  body.replaceChildren();

  const overviewSection = document.createElement("section");
  appendText(overviewSection, "h3", "", "当前概述");
  appendText(overviewSection, "p", "", data.overview);
  body.appendChild(overviewSection);

  const recapSection = document.createElement("section");
  const recapCount = (data.recentScenes ?? []).length;
  appendText(recapSection, "h3", "", "最近 " + recapCount + " 个场景回顾");
  const recap = document.createElement("ol");
  recap.id = "storyRecap";
  for (const scene of data.recentScenes ?? []) {
    const item = document.createElement("li");
    appendText(item, "span", "story-recap-title", scene.chapterTitle + " · " + scene.title);
    appendText(item, "p", "", scene.summary);
    recap.appendChild(item);
  }
  recapSection.appendChild(recap);
  body.appendChild(recapSection);

  const questionsSection = document.createElement("section");
  appendText(questionsSection, "h3", "", "可以这样问");
  const questions = document.createElement("div");
  questions.id = "storyQuestions";
  for (const question of data.questions ?? []) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = question;
    button.addEventListener("click", () => void copyStoryQuestion(question, button));
    questions.appendChild(button);
  }
  questionsSection.appendChild(questions);
  body.appendChild(questionsSection);
}

async function copyStoryQuestion(question, button) {
  const original = button.textContent;
  try {
    await copyTextToClipboard(question);
    button.textContent = "已复制到剪贴板";
  } catch {
    button.textContent = "复制失败，请手动复制";
  }
  window.setTimeout(() => {
    if (button.isConnected) button.textContent = original;
  }, 1400);
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => window.setTimeout(() => reject(new Error("clipboard timeout")), 800)),
      ]);
      return;
    } catch {
      // Fall through to the native document command for older or restricted browsers.
    }
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy command rejected");
  } finally {
    input.remove();
  }
}

async function loadStoryOverview(agent, story, generation, profileId) {
  if (activeProfileId !== profileId || viewGeneration !== generation) return;
  if (!story || Number(story.cursor ?? 0) <= 0) {
    renderStoryOverviewState("暂无可见剧情概述 · 当前剧情尚未解锁");
    return;
  }
  renderStoryOverviewState("正在生成当前剧情概述…");
  const { status, body } = await api("/v1/host/story-overview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileId, agentId: agent.agentId }),
  });
  if (activeProfileId !== profileId || viewGeneration !== generation) return;
  if (status !== 200) {
    renderStoryOverviewState(body.error?.message ?? "剧情概述暂时不可用", "story-error");
    return;
  }
  if (body.status === "empty") {
    renderStoryOverviewState(body.message ?? "暂无可见剧情概述");
    return;
  }
  renderStoryOverview(body);
}

function adaptStoryPanel() {
  const details = $("storyDetails");
  if (window.matchMedia("(max-width: 760px)").matches) {
    details.removeAttribute("open");
  } else {
    details.setAttribute("open", "");
  }
}

function topEmotions(affect, limit = 2) {
  return Object.entries(affect.emotionLabels)
    .filter(([label, strength]) => label !== "neutral" && strength >= EMOTION_MIN_STRENGTH)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, strength]) => \`\${label} \${Number(strength).toFixed(2)}\`)
    .join(" / ") || "平稳";
}

// Avatars come from personaId-keyed data URIs; a persona with no artwork
// (a hand-added agent in realm.json) falls back to a deterministic initial
// badge so the two sides stay tellable apart.
function avatarNode(label, key, uri) {
  if (uri) {
    const img = document.createElement("img");
    img.className = "avatar";
    img.src = uri;
    img.alt = "";
    return img;
  }
  let hash = 0;
  for (const ch of String(key)) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  const span = document.createElement("span");
  span.className = "avatar avatar-text";
  span.textContent = String(label).trim().slice(0, 1) || "？";
  span.style.background = \`hsl(\${hash} 52% 45%)\`;
  return span;
}

function agentAvatar(agent) {
  return avatarNode(agent.displayName, agent.personaId, AVATARS[agent.personaId]);
}

function userAvatar() {
  const profile = profiles.find((entry) => entry.profileId === activeProfileId);
  return avatarNode(profile?.displayName ?? "我", activeProfileId ?? "user");
}

function bubble(cls, text, avatar) {
  const row = document.createElement("div");
  row.className = "row " + cls;
  if (avatar) row.appendChild(avatar);
  const el = document.createElement("div");
  el.className = "bubble " + cls;
  el.textContent = text;
  row.appendChild(el);
  $("log").appendChild(row);
  $("log").scrollTop = $("log").scrollHeight;
  return el;
}

// Bubbles live inside their speaker row; dropping a bubble drops its row too.
function dropBubble(bubbleEl) {
  const row = bubbleEl.parentElement;
  if (row?.classList.contains("row")) row.remove();
  else bubbleEl.remove();
}

// In-page confirmation. The native confirm() dialog renders its own buttons
// with no surface of their own, so they disappear into the dialog background;
// this card owns both its surface and its button fills.
function confirmAction(message, confirmLabel) {
  const overlay = $("confirm");
  const ok = $("confirmOk");
  const cancel = $("confirmCancel");
  $("confirmText").textContent = message;
  ok.textContent = confirmLabel;
  overlay.hidden = false;
  ok.focus();
  return new Promise((resolve) => {
    const finish = (value) => {
      overlay.hidden = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (event) => {
      if (event.key === "Escape") finish(false);
    };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
  });
}

// The streaming placeholder starts as a centered system row; on "done" it
// becomes the agent's own bubble, avatar included.
function finishAgentBubble(bubbleEl) {
  bubbleEl.className = "bubble agent";
  const row = bubbleEl.parentElement;
  row.className = "row agent";
  if (current) row.insertBefore(agentAvatar(current), bubbleEl);
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

function setViewLoading(loading) {
  viewLoading = loading;
  $("send").disabled = loading;
  $("plotSend").disabled = loading;
  $("profilePicker").disabled = loading;
  $("agentPicker").disabled = loading;
  $("newChat").disabled = loading;
}

async function loadAgent(agent, generation = ++viewGeneration, profileId = activeProfileId) {
  current = agent;
  $("title").textContent = agent.displayName;
  renderBadge(agent);
  $("log").innerHTML = "";
  const { body } = await api("/v1/host/profile-history/" + encodeURIComponent(profileId) + "/" + encodeURIComponent(agent.agentId));
  if (activeProfileId !== profileId || viewGeneration !== generation) return;
  for (const turn of body.turns ?? []) {
    const fromAgent = turn.role === "agent";
    bubble(fromAgent ? "agent" : "user", turn.content, fromAgent ? agentAvatar(agent) : userAvatar());
  }
  if ((body.turns ?? []).length === 0) {
    bubble("sys", \`和\${agent.displayName}的故事从这里开始～\`);
    if (agent.latestReflection) {
      const thought = String(agent.latestReflection).slice(0, 80);
      bubble("sys", \`🌙 她最近在想：「\${thought}\${String(agent.latestReflection).length > 80 ? "…" : ""}」\`);
    }
  }
}

async function loadProfile(profileId) {
  const generation = ++viewGeneration;
  const previousAgentId = current?.agentId;
  activeProfileId = profileId;
  current = null;
  currentStory = null;
  $("storyBanner").hidden = true;
  renderStoryOverviewState("正在读取当前剧情…");
  setViewLoading(true);
  $("profilePicker").value = profileId;
  const { status, body } = await api("/v1/host/state/" + encodeURIComponent(profileId));
  if (activeProfileId !== profileId || viewGeneration !== generation) return;
  if (status !== 200) throw new Error(body.error?.message ?? "加载用户档案失败");
  agents = body.agents ?? [];
  const agentPicker = $("agentPicker");
  agentPicker.replaceChildren();
  for (const agent of agents) {
    const option = document.createElement("option");
    option.value = agent.agentId;
    option.textContent = agent.displayName;
    agentPicker.appendChild(option);
  }
  agentPicker.hidden = agents.length <= 1;
  if (agents.length === 0) {
    $("badge").textContent = "没有配置角色";
    renderStoryOverviewState("暂无可见剧情概述");
    setViewLoading(false);
    return;
  }
  const selectedAgent = agents.find((agent) => agent.agentId === previousAgentId) ?? agents[0];
  agentPicker.value = selectedAgent.agentId;
  await loadAgent(selectedAgent, generation, profileId);
  if (activeProfileId !== profileId || viewGeneration !== generation) return;
  currentStory = body.story ?? null;
  renderStory(currentStory);
  setViewLoading(false);
  void loadStoryOverview(selectedAgent, currentStory, generation, profileId).catch((error) => {
    if (activeProfileId === profileId && viewGeneration === generation) {
      renderStoryOverviewState(error instanceof Error ? error.message : error, "story-error");
    }
  });
}

async function refreshStoryProgress() {
  if (!activeProfileId || viewLoading || currentStory === null) return;
  const profileId = activeProfileId;
  const generation = viewGeneration;
  try {
    const { status, body } = await api("/v1/host/state/" + encodeURIComponent(profileId));
    if (activeProfileId !== profileId || viewGeneration !== generation) return;
    if (status !== 200) {
      renderStoryOverviewState(body.error?.message ?? "剧情进度刷新失败", "story-error");
      return;
    }
    const nextStory = body.story ?? null;
    if (Number(nextStory?.cursor ?? 0) === Number(currentStory?.cursor ?? 0)) return;
    await loadProfile(profileId);
  } catch (error) {
    if (activeProfileId === profileId && viewGeneration === generation) {
      renderStoryOverviewState(error instanceof Error ? error.message : error, "story-error");
    }
  }
}

async function init() {
  adaptStoryPanel();
  window.addEventListener("resize", adaptStoryPanel);
  const profileResponse = await api("/v1/host/profiles");
  profiles = profileResponse.body.profiles ?? [];
  const profilePicker = $("profilePicker");
  profilePicker.replaceChildren();
  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.profileId;
    option.textContent = profile.displayName;
    profilePicker.appendChild(option);
  }
  profilePicker.hidden = profiles.length <= 1;
  if (profiles.length === 0) throw new Error("没有可用用户档案");
  profilePicker.addEventListener("change", () => {
    const generation = viewGeneration + 1;
    void loadProfile(profilePicker.value).catch((error) => {
      if (viewGeneration !== generation) return;
      setViewLoading(false);
      bubbleError(error instanceof Error ? error.message : error);
    });
  });
  $("agentPicker").addEventListener("change", () => {
    const agent = agents.find((entry) => entry.agentId === $("agentPicker").value);
    if (!agent || viewLoading) return;
    const profileId = activeProfileId;
    const generation = ++viewGeneration;
    setViewLoading(true);
    void loadAgent(agent, generation, profileId).then(() => {
      if (viewGeneration !== generation) return;
      setViewLoading(false);
      void loadStoryOverview(agent, currentStory, generation, profileId).catch((error) => {
        if (activeProfileId === profileId && viewGeneration === generation) {
          renderStoryOverviewState(error instanceof Error ? error.message : error, "story-error");
        }
      });
    }).catch((error) => {
      if (viewGeneration !== generation) return;
      setViewLoading(false);
      bubbleError(error instanceof Error ? error.message : error);
    });
  });
  window.setInterval(() => void refreshStoryProgress(), 5000);
  await loadProfile(profiles[0].profileId);
  const plotType = $("plotType");
  plotType.innerHTML = PLOT_TYPES
    .map(([value, label]) => \`<option value="\${value}">\${label}</option>\`)
    .join("");
}

// Start a new conversation: the host drops this agent's transcript for the
// active profile, then the page reloads the (now empty) history. Memories,
// affinity, mood and story progress are kept.
$("newChat").addEventListener("click", async () => {
  if (!current || viewLoading) return;
  const profileId = activeProfileId;
  const agentId = current.agentId;
  const name = current.displayName;
  if (!(await confirmAction(\`开始新的对话？与\${name}的当前对话记录会被清空，记忆和好感度会保留。\`, "清空并开始"))) return;
  const generation = ++viewGeneration;
  setViewLoading(true);
  try {
    const { status, body } = await api("/v1/host/new-conversation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId, agentId }),
    });
    if (activeProfileId !== profileId || viewGeneration !== generation) return;
    if (status !== 200) throw new Error(body.error?.message ?? \`开始新对话失败 (HTTP \${status})\`);
    await loadAgent(current, generation, profileId);
    if (viewGeneration === generation) {
      bubble("sys", \`—— 与\${name}的新对话 ——\`);
      $("input").focus();
    }
  } catch (error) {
    if (activeProfileId === profileId && viewGeneration === generation) {
      bubbleError(error instanceof Error ? error.message : error);
    }
  } finally {
    if (activeProfileId === profileId && viewGeneration === generation) setViewLoading(false);
  }
});

$("plotForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!current || viewLoading) return;
  const profileId = activeProfileId;
  const agentId = current.agentId;
  const generation = viewGeneration;
  $("plotSend").disabled = true;
  const { status, body } = await api("/v1/host/plot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileId, agentId, type: $("plotType").value, target: "host", intensity: 1 }),
  });
  if (activeProfileId !== profileId || viewGeneration !== generation) return;
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
  if (!current || viewLoading) return;
  const profileId = activeProfileId;
  const agentId = current.agentId;
  const generation = viewGeneration;
  const content = $("input").value.trim();
  if (content.length === 0) return;

  $("input").value = "";
  setViewLoading(true);
  bubble("user", content, userAvatar());
  const pending = bubble("sys", \`\${current.displayName}正在输入…\`);

  try {
    const response = await fetch("/v1/host/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId, agentId, content, stream: true }),
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
        if (activeProfileId !== profileId || viewGeneration !== generation) {
          await reader.cancel();
          return;
        }
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
            finishAgentBubble(pending);
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
        dropBubble(pending);
      }
      if (activeProfileId !== profileId || viewGeneration !== generation) return;
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
      dropBubble(pending);
      if (response.status === 200) {
        if (activeProfileId !== profileId || viewGeneration !== generation) return;
        bubble("agent", body.reply, agentAvatar(current));
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
    dropBubble(pending);
    if (activeProfileId === profileId && viewGeneration === generation) {
      bubbleError(error instanceof Error ? error.message : error);
    }
  } finally {
    if (activeProfileId === profileId && viewGeneration === generation) {
      setViewLoading(false);
      $("input").focus();
    }
  }
});

init().catch((error) => bubbleError(error instanceof Error ? error.message : error));
</script>
</body>
</html>
`
  .replaceAll("__PLOT_TYPES__", PLOT_TYPES_JSON)
  .replaceAll("__EMOTION_LABELS__", EMOTION_LABELS_JSON)
  .replaceAll("__EMOTION_MIN_STRENGTH__", String(PROMINENT_EMOTION_MIN_STRENGTH))
  .replaceAll("__AVATARS__", AVATARS_JSON);
