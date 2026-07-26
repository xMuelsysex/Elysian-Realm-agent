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
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.6; }
  h1 { font-size: 1.3rem; }
  fieldset { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
  label { display: block; margin-top: .75rem; font-weight: 600; }
  .radio-row { display: flex; gap: 1.5rem; margin-top: .5rem; }
  .radio-row label { display: flex; align-items: center; gap: .4rem; margin: 0; font-weight: 500; }
  .radio-row input { width: auto; margin: 0; }
  select, input { width: 100%; box-sizing: border-box; padding: .45rem .6rem; margin-top: .25rem; font: inherit; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: transparent; color: inherit; }
  button { font: inherit; padding: .5rem 1.1rem; margin: 1rem .5rem 0 0; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: transparent; color: inherit; cursor: pointer; }
  button:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
  #status, #result { margin-top: 1rem; padding: .6rem .9rem; border-radius: 6px; white-space: pre-wrap; word-break: break-all; }
  .ok { background: color-mix(in srgb, #2f9e44 15%, transparent); }
  .err { background: color-mix(in srgb, #e03131 15%, transparent); }
  .muted { opacity: .7; font-size: .9rem; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<h1>Elysian Realm Agent — LLM 配置</h1>
<div id="status" class="muted">加载中…</div>
<fieldset>
  <label>接入方式</label>
  <div class="radio-row">
    <label><input type="radio" name="mode" value="custom" checked> 自定义中转（OpenAI/Anthropic 兼容）</label>
    <label><input type="radio" name="mode" value="catalog"> 官方目录</label>
  </div>

  <div id="customFields">
    <label for="baseUrl">Base URL</label>
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

async function init() {
  const [{ body: cat }, status] = [await api("/v1/admin/catalog"), await refreshStatus()];
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
    showResult(false, body.error?.message ?? body.error ?? \`测试失败 (HTTP \${status})\`);
  }
});

init().catch((error) => showResult(false, String(error)));
</script>
</body>
</html>
`;
