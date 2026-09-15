// Inline admin page for LLM configuration. Served at GET /admin by the
// service when assembled with an admin binding. Dependency-free single file:
// plain HTML + fetch against the /v1/admin endpoints. The API key input is
// write-only — the status endpoint never returns stored keys.
//
// Two access modes: custom relay (baseUrl + free-form model, default — for
// OpenAI/Anthropic-compatible proxies) and the pi-ai built-in catalog.

export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Elysian Realm Agent — LLM 配置</title>
<style>
  /* Pin the light scheme and paint the page: an unpainted page keeps the host
     window's white backdrop while the text color can resolve to the dark
     scheme's white, which renders white-on-white (page and native dropdown
     popup alike). */
  html { color-scheme: only light; background: #fff; color: #1a1a1a; }
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.6; }
  .back-link { display: inline-block; color: inherit; text-decoration: none; margin-bottom: .75rem; }
  .back-link:hover { text-decoration: underline; }
  h1 { font-size: 1.3rem; }
  fieldset { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
  label { display: block; margin-top: .75rem; font-weight: 600; }
  .radio-row { display: flex; gap: 1.5rem; margin-top: .5rem; }
  .radio-row label { display: flex; align-items: center; gap: .4rem; margin: 0; font-weight: 500; }
  .radio-row input { width: auto; margin: 0; }
  select, input { width: 100%; box-sizing: border-box; padding: .45rem .6rem; margin-top: .25rem; font: inherit; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); background: color-mix(in srgb, currentColor 8%, transparent); color: inherit; }
  button { font: inherit; padding: .5rem 1.1rem; margin: 1rem .5rem 0 0; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); background: color-mix(in srgb, currentColor 8%, transparent); color: inherit; cursor: pointer; }
  button:hover { background: color-mix(in srgb, currentColor 18%, transparent); }
  #status, #result { margin-top: 1rem; padding: .6rem .9rem; border-radius: 6px; white-space: pre-wrap; word-break: break-all; }
  .ok { background: color-mix(in srgb, #2f9e44 15%, transparent); }
  .err { background: color-mix(in srgb, #e03131 15%, transparent); }
  .muted { opacity: .7; font-size: .9rem; }
  #profilePanel, #storyPanel { margin: 1.5rem 0; }
  #profilePanel h2, #storyPanel h2 { font-size: 1.05rem; margin: 0 0 .75rem; }
  .profile-controls { display: grid; grid-template-columns: 1fr 1fr; gap: .65rem; align-items: end; }
  .profile-controls label { margin-top: 0; }
  .profile-controls .wide { grid-column: 1 / -1; }
  #profilePicker, #storyCursor { margin-top: .25rem; }
  #profileResult, #storyResult { margin-top: .6rem; }
  #dashboard { margin: 1.5rem 0; }
  #dashboard h2 { font-size: 1.05rem; margin: 0 0 .75rem; }
  .agent-card { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 8px; padding: .9rem 1rem; margin: .8rem 0; }
  .agent-card h3 { margin: 0; font-size: 1rem; }
  .agent-meta { margin-top: .25rem; opacity: .7; font-size: .85rem; }
  .dimension-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .65rem; margin: .9rem 0; }
  .dimension { font-size: .8rem; }
  .dimension-head { display: flex; justify-content: space-between; gap: .5rem; margin-bottom: .25rem; }
  .dimension-bar { height: .4rem; border-radius: 999px; background: color-mix(in srgb, currentColor 12%, transparent); overflow: hidden; }
  .dimension-fill { height: 100%; border-radius: inherit; background: #4dabf7; }
  details { margin-top: .75rem; }
  summary { cursor: pointer; font-weight: 600; }
  .memory-list { display: flex; flex-direction: column; gap: .5rem; margin-top: .6rem; }
  .memory { padding: .55rem .7rem; border-radius: 6px; background: color-mix(in srgb, currentColor 7%, transparent); }
  .memory-head, .memory-emotion { font-size: .75rem; opacity: .7; }
  .memory-content { margin-top: .25rem; white-space: pre-wrap; word-break: break-word; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<a class="back-link" href="/chat" aria-label="返回聊天页面">← 返回聊天</a>
<a class="back-link" href="/test" aria-label="打开剧情测试台">🧪 剧情测试台</a>
<h1>Elysian Realm Agent — LLM 配置</h1>
<div id="status" class="muted">加载中…</div>
<div id="stats" class="muted" hidden></div>
<section id="profilePanel" hidden aria-labelledby="profileTitle">
  <h2 id="profileTitle">用户档案</h2>
  <div class="profile-controls">
    <label class="wide" for="profilePicker">当前档案</label>
    <select id="profilePicker" class="wide"></select>
    <label for="profileId">新档案 ID</label>
    <input id="profileId" type="text" placeholder="例如 user_2" autocomplete="off">
    <label for="profileName">显示名称</label>
    <input id="profileName" type="text" placeholder="主人" autocomplete="off">
    <label class="wide" for="profileDescription">自我介绍（可选）</label>
    <input id="profileDescription" class="wide" type="text" autocomplete="off">
  </div>
  <button id="saveProfile" type="button">保存当前档案</button>
  <button id="createProfile" type="button">创建档案</button>
  <div id="profileResult" class="muted"></div>
</section>
<section id="storyPanel" hidden aria-labelledby="storyTitle">
  <h2 id="storyTitle">剧情进度</h2>
  <label for="storyCursor">解锁到场景</label>
  <select id="storyCursor"></select>
  <div id="storySource" class="muted"></div>
  <button id="saveStory" type="button">保存剧情进度</button>
  <div id="storyResult" class="muted"></div>
</section>
<section id="dashboard" hidden aria-labelledby="dashboardTitle">
  <h2 id="dashboardTitle">角色属性与记忆</h2>
  <div id="agentCards"></div>
</section>
<fieldset>
  <label>接入方式</label>
  <div class="radio-row">
    <label><input type="radio" name="mode" value="custom" checked> 自定义中转（OpenAI/Anthropic 兼容）</label>
    <label><input type="radio" name="mode" value="catalog"> 官方目录</label>
  </div>

  <div id="customFields">
    <label for="baseUrl">Base URL <span class="muted">（OpenAI 兼容通常以 /v1 结尾，实际请求打到 {Base URL}/chat/completions）</span></label>
    <input id="baseUrl" type="url" placeholder="https://api.example.com/v1" autocomplete="off">
    <label for="customModel">Model <span class="muted">（中转站的模型名，自由填写）</span></label>
    <input id="customModel" type="text" placeholder="gpt-4o-mini / claude-sonnet-4-6 / …" autocomplete="off">
    <label for="apiFormat">接口格式</label>
    <select id="apiFormat">
      <option value="openai-completions" selected>OpenAI 兼容 (/chat/completions)</option>
      <option value="anthropic-messages">Anthropic 兼容 (/messages)</option>
    </select>
  </div>

  <div id="catalogFields" hidden>
    <label for="provider">Provider</label>
    <select id="provider"></select>
    <label for="model">Model</label>
    <select id="model"></select>
  </div>

  <label for="apiKey">API Key <span class="muted">（目录模式留空则使用 provider 的标准环境变量）</span></label>
  <input id="apiKey" type="password" autocomplete="off" placeholder="sk-...">
  <div>
    <button id="save">保存并启用</button>
    <button id="test">测试连接</button>
  </div>
</fieldset>
<div id="result" hidden></div>
<script>
const $ = (id) => document.getElementById(id);
let catalog = [];
let profiles = [];
let activeProfileId = null;
let activeStory = null;
let profileViewGeneration = 0;
const DIMENSION_LABELS = {
  sociability: "外向度",
  empathy: "共情度",
  rationality: "理性度",
  courage: "勇气",
  curiosity: "好奇度",
  independence: "独立度",
};

const currentMode = () => document.querySelector('input[name="mode"]:checked').value;

function applyMode() {
  const mode = currentMode();
  $("customFields").hidden = mode !== "custom";
  $("catalogFields").hidden = mode !== "catalog";
}
for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener("change", applyMode);
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function renderModels() {
  const provider = catalog.find((entry) => entry.id === $("provider").value);
  $("model").innerHTML = (provider?.models ?? [])
    .map((model) => \`<option value="\${model.id}">\${model.id}</option>\`)
    .join("");
}

function showResult(ok, text) {
  const el = $("result");
  el.hidden = false;
  el.className = ok ? "ok" : "err";
  el.textContent = text;
}

function currentSelection() {
  const config = currentMode() === "custom"
    ? {
        baseUrl: $("baseUrl").value.trim(),
        model: $("customModel").value.trim(),
        api: $("apiFormat").value,
      }
    : { provider: $("provider").value, model: $("model").value };
  const key = $("apiKey").value.trim();
  if (key.length > 0) config.apiKey = key;
  return config;
}

async function refreshStatus() {
  const { body } = await api("/v1/admin/llm-config");
  const el = $("status");
  if (body.configured) {
    const target = body.baseUrl ? \`\${body.baseUrl} · \${body.model}\` : \`\${body.provider} / \${body.model}\`;
    el.textContent = \`当前配置：\${target}（配置来源: \${body.configSource}, 凭据来源: \${body.keySource}）\`;
    el.className = "ok";
  } else {
    el.textContent = "尚未配置对话模型 — 填写中转地址或选择官方模型并保存即可启用对话端点。";
    el.className = "muted";
  }
  return body;
}

async function refreshStoreStats() {
  // Best-effort: the host API is served alongside admin; a missing endpoint
  // (e.g. standalone service) must not break the page.
  try {
    const { status, body } = await api("/v1/host/stats");
    if (status !== 200 || !body?.totals) {
      return;
    }
    const agents = (body.agents ?? [])
      .map((agent) => \`\${agent.displayName}: \${agent.memories} 条记忆\`)
      .join(" · ");
    const stale = body.totals.staleMemories ?? 0;
    const el = $("stats");
    el.textContent = \`存储：\${body.totals.memories} 条记忆 / \${body.totals.conversationTurns} 轮对话\${agents ? \`（\${agents}）\` : ""}\${stale > 0 ? \`，90 天未用 \${stale} 条\` : ""}\`;
    el.hidden = false;
  } catch {
    // ignore — stats are auxiliary
  }
}

function formatMemoryDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function appendText(parent, tag, className, text) {
  const child = document.createElement(tag);
  if (className) child.className = className;
  child.textContent = String(text);
  parent.appendChild(child);
  return child;
}

function renderStory(story) {
  activeStory = story;
  const picker = $("storyCursor");
  picker.innerHTML = "";
  const initial = document.createElement("option");
  initial.value = "0";
  initial.textContent = "尚未解锁剧情";
  picker.appendChild(initial);
  for (const scene of story.scenes ?? []) {
    const option = document.createElement("option");
    option.value = String(Number(scene.order) + 1);
    option.textContent = "场景 " + (Number(scene.order) + 1) + " · " + scene.title + (scene.available === false ? "（源页面缺失）" : "");
    picker.appendChild(option);
  }
  picker.value = String(story.cursor ?? 0);
  $("storySource").textContent = "来源：" + story.source + " · 可用场景 " + story.totalScenes + " · 游标回退会同步回退角色状态" + (story.diagnostics?.length ? " · 缺失页面 " + story.diagnostics.length : "");
  $("storyPanel").hidden = false;
  $("saveStory").disabled = false;
}

function renderProfiles() {
  const picker = $("profilePicker");
  picker.replaceChildren();
  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.profileId;
    option.textContent = profile.displayName + "（" + profile.profileId + "）";
    picker.appendChild(option);
  }
  picker.value = activeProfileId ?? profiles[0]?.profileId ?? "";
  $("profilePanel").hidden = profiles.length === 0;
}

function fillProfileForm(profile) {
  $("profileId").value = profile?.profileId ?? "";
  $("profileName").value = profile?.displayName ?? "";
  $("profileDescription").value = profile?.profile ?? "";
}

function renderDashboard(agents) {
  const cards = $("agentCards");
  cards.replaceChildren();
  for (const agent of agents) {
    const card = document.createElement("article");
    card.className = "agent-card";
    appendText(card, "h3", "", agent.displayName);
    appendText(
      card,
      "div",
      "agent-meta",
      "好感 " + agent.affinity + " · 心情 " + (agent.mood?.mood ?? "平静") + " · 记忆 " + agent.memoryCount,
    );

    const dimensions = document.createElement("div");
    dimensions.className = "dimension-grid";
    for (const [key, label] of Object.entries(DIMENSION_LABELS)) {
      const value = Number(agent.personalityDimensions?.[key] ?? 50);
      const dimension = document.createElement("div");
      dimension.className = "dimension";
      const head = document.createElement("div");
      head.className = "dimension-head";
      appendText(head, "span", "", label);
      appendText(head, "strong", "", value + "/100");
      dimension.appendChild(head);
      const bar = document.createElement("div");
      bar.className = "dimension-bar";
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-label", label);
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      bar.setAttribute("aria-valuenow", String(value));
      const fill = document.createElement("div");
      fill.className = "dimension-fill";
      fill.style.width = Math.min(100, Math.max(0, value)) + "%";
      bar.appendChild(fill);
      dimension.appendChild(bar);
      dimensions.appendChild(dimension);
    }
    card.appendChild(dimensions);

    const memories = Array.isArray(agent.memories) ? agent.memories : [];
    const details = document.createElement("details");
    details.open = true;
    appendText(details, "summary", "", "最近记忆（" + memories.length + " 条，最多 100 条）");
    const memoryList = document.createElement("div");
    memoryList.className = "memory-list";
    if (memories.length === 0) {
      appendText(memoryList, "div", "muted", "暂无记忆");
    }
    for (const memory of memories) {
      const item = document.createElement("article");
      item.className = "memory";
      let heading = (memory.kind ?? "memory") + " · " + formatMemoryDate(memory.createdAt) + " · 重要度 " + memory.importance;
      if (Array.isArray(memory.tags) && memory.tags.length > 0) {
        heading += " · " + memory.tags.join("、");
      }
      appendText(item, "div", "memory-head", heading);
      if (memory.emotion) {
        appendText(
          item,
          "div",
          "memory-emotion",
          "情绪 valence " + Number(memory.emotion.valence).toFixed(2) + " · arousal " + Number(memory.emotion.arousal).toFixed(2),
        );
      }
      appendText(item, "div", "memory-content", memory.content);
      memoryList.appendChild(item);
    }
    details.appendChild(memoryList);
    card.appendChild(details);
    cards.appendChild(card);
  }
  $("dashboard").hidden = agents.length === 0;
}

async function refreshRealmDashboard(profileId = activeProfileId, generation = profileViewGeneration) {
  const path = profileId ? "/v1/admin/realm/" + encodeURIComponent(profileId) : "/v1/admin/realm";
  const { status, body } = await api(path);
  if (generation !== profileViewGeneration || profileId !== activeProfileId) return;
  if (status === 200 && Array.isArray(body.agents)) {
    activeProfileId = body.profile?.participantId ?? profileId;
    fillProfileForm(body.profile);
    renderStory(body.story);
    renderDashboard(body.agents);
  }
}

async function refreshProfiles() {
  const generation = ++profileViewGeneration;
  activeStory = null;
  $("saveStory").disabled = true;
  const { status, body } = await api("/v1/admin/profiles");
  if (generation !== profileViewGeneration || status !== 200 || !Array.isArray(body.profiles)) return;
  profiles = body.profiles;
  if (!profiles.some((profile) => profile.profileId === activeProfileId)) {
    activeProfileId = profiles[0]?.profileId ?? null;
  }
  renderProfiles();
  if (activeProfileId) await refreshRealmDashboard(activeProfileId, generation);
}

$("profilePicker").addEventListener("change", async () => {
  const generation = ++profileViewGeneration;
  activeProfileId = $("profilePicker").value;
  activeStory = null;
  $("saveStory").disabled = true;
  const profile = profiles.find((entry) => entry.profileId === activeProfileId);
  fillProfileForm(profile);
  await refreshRealmDashboard(activeProfileId, generation);
});

$("saveProfile").addEventListener("click", async () => {
  if (!activeProfileId) return;
  const { status, body } = await api("/v1/admin/profiles/" + encodeURIComponent(activeProfileId), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: $("profileName").value.trim(), profile: $("profileDescription").value.trim() || undefined }),
  });
  $("profileResult").textContent = status === 200 ? "档案已保存。" : (body.error?.message ?? "档案保存失败");
  if (status === 200) await refreshProfiles();
});

$("createProfile").addEventListener("click", async () => {
  const { status, body } = await api("/v1/admin/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileId: $("profileId").value.trim(), displayName: $("profileName").value.trim(), profile: $("profileDescription").value.trim() || undefined }),
  });
  $("profileResult").textContent = status === 201 ? "档案已创建。" : (body.error?.message ?? "档案创建失败");
  if (status === 201) {
    activeProfileId = body.profile.profileId;
    await refreshProfiles();
  }
});

$("saveStory").addEventListener("click", async () => {
  if (!activeProfileId || !activeStory) return;
  const { status, body } = await api("/v1/admin/profiles/" + encodeURIComponent(activeProfileId) + "/story", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cursor: Number($("storyCursor").value) }),
  });
  $("storyResult").textContent = status === 200 ? "剧情进度已保存。" : (body.error?.message ?? "剧情进度保存失败");
  if (status === 200) await refreshProfiles();
});

async function init() {
  const [{ body: cat }, status] = [await api("/v1/admin/catalog"), await refreshStatus()];
  void refreshStoreStats();
  catalog = cat.providers ?? [];
  $("provider").innerHTML = catalog
    .map((entry) => \`<option value="\${entry.id}">\${entry.id}</option>\`)
    .join("");
  renderModels();

  if (status.configured) {
    if (status.baseUrl) {
      $("baseUrl").value = status.baseUrl;
      $("customModel").value = status.model ?? "";
    } else if (status.provider) {
      document.querySelector('input[name="mode"][value="catalog"]').checked = true;
      $("provider").value = status.provider;
      renderModels();
      if (status.model) $("model").value = status.model;
    }
  }
  applyMode();
  await refreshProfiles();
}

$("provider").addEventListener("change", renderModels);

$("save").addEventListener("click", async () => {
  showResult(true, "保存中…");
  const { status, body } = await api("/v1/admin/llm-config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(currentSelection()),
  });
  if (status === 200) {
    $("apiKey").value = "";
    showResult(true, "已保存并热加载 — 对话端点已启用。");
    await refreshStatus();
    void refreshStoreStats();
  } else {
    showResult(false, body.error?.message ?? \`保存失败 (HTTP \${status})\`);
  }
});

$("test").addEventListener("click", async () => {
  showResult(true, "测试中…（真实调用一次 LLM，可能需要几秒）");
  const useCandidate = currentMode() === "custom" || $("apiKey").value.trim().length > 0;
  const payload = useCandidate ? JSON.stringify(currentSelection()) : undefined;
  const { status, body } = await api("/v1/admin/llm-config/test", {
    method: "POST",
    ...(payload ? { headers: { "content-type": "application/json" }, body: payload } : {}),
  });
  if (status === 200 && body.ok) {
    showResult(true, \`连接成功 (\${body.model})：\${body.content}\`);
  } else {
    const detail = body.error?.message ?? body.error ?? \`测试失败 (HTTP \${status})\`;
    showResult(false, body.target ? \`\${detail}\\n实际请求: \${body.target}\` : detail);
  }
});

init().catch((error) => showResult(false, String(error)));
</script>
</body>
</html>
`;
