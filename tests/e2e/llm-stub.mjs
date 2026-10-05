#!/usr/bin/env node
// Local OpenAI-compatible streaming stub for end-to-end SSE verification.
// POST /v1/chat/completions:
//   stream=true  -> SSE chunks with 3 progressive text deltas then [DONE]
//   stream=false -> JSON completion carrying the affect-analysis JSON
import { createServer } from "node:http";

const PORT = Number(process.env.STUB_PORT ?? 4330);
const ANALYSIS_JSON =
  '{"affinityDelta": 3, "mood": "开心", "moodIntensity": 0.7, "reason": "stub analysis", "memoryImportance": 4, "emotion": {"valence": 0.6, "arousal": 0.5}}';

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { /* ignore */ }
    const stream = body.stream === true;
    const model = typeof body.model === "string" ? body.model : "stub";

    res.setHeader("content-type", stream ? "text/event-stream" : "application/json");
    res.setHeader("cache-control", "no-store");
    res.writeHead(200);

    if (stream) {
      // pi-ai's completeSimple streams under the hood even for "non-stream"
      // calls, so the analysis/reflection requests arrive as streams too.
      // Route on the system prompt: each LLM seam has a distinctive prompt.
      const systemText = body.messages?.find((m) => m.role === "system")?.content ?? "";
      const userText = body.messages?.find((m) => m.role === "user")?.content ?? "";
      let replyTexts;
      if (systemText.includes("analyze how a roleplayed character")) {
        // Affect analysis after a conversation exchange.
        replyTexts = [ANALYSIS_JSON];
      } else if (systemText.includes("聊天界面的剧情向导")) {
        const sceneIds = [...userText.matchAll(/\[sceneId=([^\]]+)\]/g)].map((match) => match[1]);
        replyTexts = [JSON.stringify({
          overview: "角色正在依据已解锁的剧情继续前行，当前故事线索仍在逐步展开。",
          recaps: sceneIds.map((sceneId) => ({ sceneId, text: "这一场景记录了当前故事线索的一次推进。" })),
          questions: ["这段剧情接下来会怎样发展？", "你怎么看待当前遇到的人和事？", "我可以从哪里开始了解这段故事？"],
        })];
      } else if (systemText.includes("inner voice of")) {
        // Nightly reflection: a JSON array citing at least one evidence id.
        const firstId = /id=([A-Za-z0-9_]+)/.exec(userText)?.[1] ?? "e1";
        replyTexts = [
          JSON.stringify([
            {
              content: "今天从开心到低落的起伏，让我更懂自己在乎什么了。",
              evidenceIds: [firstId],
              importance: 7,
            },
          ]),
        ];
      } else {
        // Conversation reply: stream progressively so the harness can assert
        // multi-frame delivery and first-delta latency.
        replyTexts = ["你好", "呀，", "今天也在花园", "晒太阳呢♪"];
      }
      const deltas = replyTexts;
      let i = 0;
      const push = () => {
        if (i >= deltas.length) {
          // Final chunk must carry finish_reason before [DONE] (OpenAI contract).
          const finalPayload = JSON.stringify({
            id: "chatcmpl-stub",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          });
          res.write(`data: ${finalPayload}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        const delta = deltas[i];
        i += 1;
        const payload = JSON.stringify({
          id: "chatcmpl-stub",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
        });
        res.write(`data: ${payload}\n\n`);
        setTimeout(push, 120); // progressive delivery: 120ms between chunks
      };
      push();
      return;
    }

    // Non-stream: canned completion whose content is the affect analysis JSON.
    const payload = JSON.stringify({
      id: "chatcmpl-stub",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: ANALYSIS_JSON },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
    res.end(payload);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stub listening on 127.0.0.1:${PORT}`);
});
