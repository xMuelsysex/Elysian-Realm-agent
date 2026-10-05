// Local story inspection page: show the active model and the exact dialogue
// fragments selected for a test message without exposing API credentials.

export const TEST_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Elysian Realm — 剧情测试台</title>
<style>
  /* Pin the light scheme and paint the page: an unpainted page keeps the host
     window's white backdrop while the text color can resolve to the dark
     scheme's white, which renders white-on-white (page and native dropdown
     popup alike). */
  html { color-scheme: only light; background: #fff; color: #1a1a1a; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; max-width: 72rem; margin: 0 auto; padding: 0 1rem 3rem; line-height: 1.5; }
  nav { display: flex; gap: .75rem; padding: 1rem 0 .5rem; }
  nav a { color: inherit; text-decoration: none; padding: .3rem .55rem; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); border-radius: 6px; background: color-mix(in srgb, currentColor 8%, transparent); }
  nav a:hover { background: color-mix(in srgb, currentColor 18%, transparent); }
  h1 { font-size: 1.35rem; margin: .75rem 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 0 0 .75rem; }
  .muted { opacity: .7; font-size: .9rem; }
  .panel { border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 10px; padding: 1rem 1.1rem; margin: 1rem 0; }
  .model-grid, .control-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .75rem; }
  .model-item { min-width: 0; padding: .65rem .75rem; border-radius: 7px; background: color-mix(in srgb, currentColor 7%, transparent); }
  .model-label { display: block; font-size: .75rem; opacity: .65; }
  .model-value { display: block; margin-top: .2rem; overflow-wrap: anywhere; }
  label { display: block; font-weight: 600; }
  select, textarea, button { width: 100%; font: inherit; }
  select, textarea { margin-top: .3rem; padding: .5rem .6rem; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); background: color-mix(in srgb, currentColor 8%, transparent); color: inherit; }
  textarea { resize: vertical; min-height: 6rem; }
  .wide { grid-column: 1 / -1; }
  .actions { display: flex; gap: .65rem; margin-top: .85rem; }
  button { width: auto; padding: .5rem 1rem; border-radius: 7px; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); background: color-mix(in srgb, currentColor 8%, transparent); color: inherit; cursor: pointer; }
  button:hover { background: color-mix(in srgb, currentColor 18%, transparent); }
  button:disabled { opacity: .5; cursor: wait; }
  #actionStatus, #replyBox { margin-top: .8rem; padding: .65rem .8rem; border-radius: 7px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .ok { background: color-mix(in srgb, #2f9e44 15%, transparent); }
  .err { background: color-mix(in srgb, #e03131 15%, transparent); }
  .story-meta { margin-bottom: .8rem; }
  .fragment { border-left: 3px solid #4dabf7; padding: .7rem .85rem; margin: .75rem 0; background: color-mix(in srgb, #4dabf7 7%, transparent); }
  .fragment h3 { margin: 0; font-size: .98rem; }
  .fragment-meta { margin: .2rem 0 .55rem; font-size: .78rem; opacity: .72; overflow-wrap: anywhere; }
  .line { display: flex; gap: .4rem; padding: .25rem 0; border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
  .line-kind { flex: 0 0 auto; font-size: .76rem; opacity: .72; }
  .line-speaker { font-weight: 600; flex: 0 0 auto; }
  .line-text { white-space: pre-wrap; overflow-wrap: anywhere; }
  details { margin-top: .85rem; }
  summary { cursor: pointer; font-weight: 600; }
  pre { max-height: 28rem; overflow: auto; padding: .8rem; border-radius: 7px; background: color-mix(in srgb, currentColor 8%, transparent); white-space: pre-wrap; overflow-wrap: anywhere; font-size: .78rem; }
  [hidden] { display: none !important; }
  @media (max-width: 48rem) { .model-grid, .control-grid { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 30rem) { .model-grid, .control-grid { grid-template-columns: 1fr; } .actions { flex-direction: column; } button { width: 100%; } }
</style>
</head>
<body>
<nav aria-label="页面导航">
  <a href="/chat">← 返回聊天</a>
  <a href="/admin">⚙ 设置</a>
</nav>
<h1>剧情测试台</h1>
<p class="muted">用于确认一次对话使用了哪个模型，以及角色实际读取了哪些已解锁剧情片段。预览不会写入状态；“发送并测试”会写入当前档案的聊天历史。</p>

<section class="panel" aria-labelledby="modelTitle">
  <h2 id="modelTitle">当前模型</h2>
  <div class="model-grid">
    <div class="model-item"><span class="model-label">Model</span><strong id="modelName" class="model-value">加载中…</strong></div>
    <div class="model-item"><span class="model-label">Provider / Base URL</span><span id="modelTarget" class="model-value">—</span></div>
    <div class="model-item"><span class="model-label">配置来源</span><span id="modelSource" class="model-value">—</span></div>
    <div class="model-item"><span class="model-label">凭据</span><span id="modelKey" class="model-value">不会显示 API Key</span></div>
  </div>
</section>

<section class="panel" aria-labelledby="requestTitle">
  <h2 id="requestTitle">测试请求</h2>
  <div class="control-grid">
    <label for="profilePicker">用户档案<select id="profilePicker"></select></label>
    <label for="agentPicker">角色<select id="agentPicker"></select></label>
    <div id="storyState" class="muted wide">剧情状态加载中…</div>
    <label class="wide" for="message">测试消息<textarea id="message">请告诉我，你还记得刚才在乐土发生的事吗？</textarea></label>
  </div>
  <div class="actions">
    <button id="preview" type="button">预览读取上下文</button>
    <button id="send" type="button">发送并测试</button>
  </div>
  <div id="actionStatus" class="muted" hidden aria-live="polite"></div>
</section>

<section id="inspection" class="panel" hidden aria-labelledby="inspectionTitle">
  <h2 id="inspectionTitle">角色实际读取的剧情</h2>
  <div id="storyMeta" class="story-meta muted"></div>
  <div id="storyHits"></div>
  <details>
    <summary>模型收到的剧情上下文文本</summary>
    <pre id="storyPrompt"></pre>
  </details>
  <details>
    <summary>本次检查数据 JSON</summary>
    <pre id="inspectionJson"></pre>
  </details>
</section>

<section id="response" class="panel" hidden aria-labelledby="responseTitle">
  <h2 id="responseTitle">模型回复</h2>
  <div id="replyMeta" class="muted"></div>
  <div id="replyBox"></div>
</section>

<script>
const $ = (id) => document.getElementById(id);
const KIND_LABELS = { dialogue: "台词", narration: "旁白", option: "选项", system: "系统", annotation: "注释" };
let profiles = [];
let agents = [];
let busy = false;

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function appendText(parent, tag, className, text) {
  const child = document.createElement(tag);
  if (className) child.className = className;
  child.textContent = String(text);
  parent.appendChild(child);
  return child;
}

function setActionStatus(ok, text) {
  const el = $("actionStatus");
  el.hidden = false;
  el.className = ok ? "ok" : "err";
  el.textContent = text;
}

function errorMessage(status, body) {
  return body?.error?.message ?? ("请求失败（HTTP " + status + "）");
}

function setBusy(value) {
  busy = value;
  for (const id of ["profilePicker", "agentPicker", "message", "preview", "send"]) {
    $(id).disabled = value;
  }
}

function renderModel(model) {
  const configured = model?.configured === true;
  $("modelName").textContent = configured ? (model.model ?? "未提供") : "未配置";
  $("modelTarget").textContent = configured
    ? (model.baseUrl ? ((model.provider ?? "custom") + " · " + model.baseUrl) : ((model.provider ?? "unknown") + " · 目录模型"))
    : "请先在设置中配置模型";
  $("modelSource").textContent = model?.configSource ?? "—";
  $("modelKey").textContent = model?.keySource === "stored"
    ? "已保存（仅显示来源）"
    : model?.keySource === "env"
      ? "环境配置（仅显示来源）"
      : "未配置 / 不显示 Key";
}

function fillSelect(select, entries, valueFor, labelFor) {
  select.replaceChildren();
  for (const entry of entries) {
    const option = document.createElement("option");
    option.value = valueFor(entry);
    option.textContent = labelFor(entry);
    select.appendChild(option);
  }
}

function renderProfileState(state) {
  const story = state.story ?? {};
  $("storyState").textContent = "当前剧情：游标 " + (story.cursor ?? 0) + " / " + (story.totalScenes ?? 0) + " · 档案 " + (state.user?.participantId ?? "—") + " · 角色 " + (agents.length) + " 名";
}

async function loadProfile(profileId) {
  const { status, body } = await api("/v1/host/state/" + encodeURIComponent(profileId));
  if (status !== 200 || !Array.isArray(body.agents)) {
    throw new Error(errorMessage(status, body));
  }
  agents = body.agents;
  fillSelect($("agentPicker"), agents, (agent) => agent.agentId, (agent) => agent.displayName + "（" + agent.agentId + "）");
  renderProfileState(body);
}

function currentInput() {
  return {
    profileId: $("profilePicker").value,
    agentId: $("agentPicker").value,
    content: $("message").value,
  };
}

function renderSource(parent, url) {
  const source = document.createElement("span");
  source.className = "fragment-meta";
  source.textContent = "来源：" + url;
  parent.appendChild(source);
}

function renderInspection(inspection) {
  const hits = Array.isArray(inspection?.storyContext) ? inspection.storyContext : [];
  $("inspection").hidden = false;
  $("storyMeta").textContent = "档案 " + inspection.profileId + " · 角色 " + inspection.agent.displayName + " · 游标 " + inspection.storyCursor + " · 本次注入 " + hits.length + " 个场景片段 · 历史 " + inspection.historyTurns + " 轮 · 记忆 " + inspection.memoryCount + " 条";
  const list = $("storyHits");
  list.replaceChildren();
  if (hits.length === 0) {
    appendText(list, "div", "muted", "本次没有可注入的剧情片段：可能尚未解锁，或当前消息与角色已知剧情没有命中。模型不会读取未解锁内容。");
  }
  for (const hit of hits) {
    const fragment = document.createElement("article");
    fragment.className = "fragment";
    appendText(fragment, "h3", "", "场景 " + (Number(hit.scene.order) + 1) + " · " + hit.scene.title);
    appendText(fragment, "div", "fragment-meta", "章节：" + hit.scene.chapterTitle + " · 阶段命中相关度：" + Number(hit.score).toFixed(3));
    renderSource(fragment, hit.scene.sourceUrl);
    for (const line of hit.lines ?? []) {
      const row = document.createElement("div");
      row.className = "line";
      appendText(row, "span", "line-kind", "[" + (KIND_LABELS[line.kind] ?? line.kind) + "]");
      if (line.speaker) appendText(row, "span", "line-speaker", line.speaker + ":");
      appendText(row, "span", "line-text", line.text);
      fragment.appendChild(row);
    }
    list.appendChild(fragment);
  }
  $("storyPrompt").textContent = inspection.storyPrompt || "本次没有注入剧情上下文文本。";
  $("inspectionJson").textContent = JSON.stringify(inspection, null, 2);
}

function renderReply(result) {
  $("response").hidden = false;
  $("replyMeta").textContent = result.displayName + " · 好感 " + result.affinity + " · 心情 " + (result.mood?.mood ?? "平静") + " · 分析 " + result.analysis;
  $("replyBox").className = "ok";
  $("replyBox").textContent = result.reply;
}

async function previewRequest() {
  const { status, body } = await api("/v1/test/inspect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(currentInput()),
  });
  if (status !== 200) throw new Error(errorMessage(status, body));
  renderModel(body.model);
  renderInspection(body.inspection);
  setActionStatus(true, "预览完成：没有调用模型，也没有写入档案状态。");
}

$("preview").addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  try {
    await previewRequest();
  } catch (error) {
    setActionStatus(false, error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
});

$("send").addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  try {
    const { status, body } = await api("/v1/test/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(currentInput()),
    });
    if (status !== 200) throw new Error(errorMessage(status, body));
    renderModel(body.model);
    renderInspection(body.inspection);
    renderReply(body.result);
    setActionStatus(true, "测试对话完成：回复和测试消息已写入当前档案。");
  } catch (error) {
    setActionStatus(false, error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
});

$("profilePicker").addEventListener("change", async () => {
  if (busy) return;
  setBusy(true);
  try {
    await loadProfile($("profilePicker").value);
    setActionStatus(true, "已切换档案，请重新预览读取上下文。");
  } catch (error) {
    setActionStatus(false, error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
});

async function init() {
  const { status, body } = await api("/v1/test/status");
  if (status !== 200 || !Array.isArray(body.profiles)) {
    throw new Error(errorMessage(status, body));
  }
  renderModel(body.model);
  profiles = body.profiles;
  fillSelect($("profilePicker"), profiles, (profile) => profile.profileId, (profile) => profile.displayName + "（" + profile.profileId + "）");
  if (profiles.length === 0) throw new Error("没有可用用户档案");
  await loadProfile(profiles[0].profileId);
}

init().catch((error) => {
  setActionStatus(false, error instanceof Error ? error.message : String(error));
});
</script>
</body>
</html>`;
