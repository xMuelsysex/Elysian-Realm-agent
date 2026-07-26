// Chat page: dependency-free single file served at GET /chat. Bubbles, an
// affinity/mood badge that updates after every exchange, and an agent picker
// when the realm has more than one persona.

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
  .agent { align-self: flex-start; background: color-mix(in srgb, currentColor 10%, transparent); border-bottom-left-radius: 4px; }
  .user { align-self: flex-end; background: color-mix(in srgb, #4dabf7 22%, transparent); border-bottom-right-radius: 4px; }
  .sys { align-self: center; font-size: .8rem; opacity: .65; }
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
<form id="form">
  <input id="input" autocomplete="off" placeholder="说点什么…">
  <button id="send" type="submit">发送</button>
</form>
<script>
const $ = (id) => document.getElementById(id);
let agents = [];
let current = null;

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
  $("badge").innerHTML = \`\${heart(agent.affinity)} 好感 \${agent.affinity}<br>心情 \${moodText}\`;
}

function bubble(cls, text) {
  const el = document.createElement("div");
  el.className = "bubble " + cls;
  el.textContent = text;
  $("log").appendChild(el);
  $("log").scrollTop = $("log").scrollHeight;
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
  await loadAgent(agents[0]);
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!current) return;
  const content = $("input").value.trim();
  if (content.length === 0) return;

  $("input").value = "";
  $("send").disabled = true;
  bubble("user", content);
  const pending = bubble("sys", \`\${current.displayName}正在输入…\`);

  const { status, body } = await api("/v1/host/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: current.agentId, content }),
  });
  pending.remove();
  $("send").disabled = false;

  if (status === 200) {
    bubble("agent", body.reply);
    current.affinity = body.affinity;
    current.mood = body.mood;
    renderBadge(current);
  } else {
    bubble("sys", body.error?.message ?? \`发送失败 (HTTP \${status})\`);
  }
  $("input").focus();
});

init().catch((error) => bubble("sys", String(error)));
</script>
</body>
</html>
`;
