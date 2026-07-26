import test from "node:test";
import assert from "node:assert/strict";

import {
  startAgentService,
  stopAgentService,
  type AdminRequestHandler,
} from "@elysian/simulation-agent/service";

const echoHandler: AdminRequestHandler = (method, path, body) =>
  Promise.resolve({ status: 200, body: { method, path, body: body ?? null } });

test("admin routes 404 explicitly when admin is not enabled", async () => {
  const running = await startAgentService({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${running.address.port}/admin`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "ADMIN_NOT_ENABLED");
  } finally {
    await stopAgentService(running.server);
  }
});

test("admin page and api are reachable without a token on a tokenless instance", async () => {
  const running = await startAgentService(
    { host: "127.0.0.1", port: 0 },
    { admin: { handler: echoHandler, page: "<!doctype html><title>Elysian Admin</title>" } },
  );
  try {
    const base = `http://127.0.0.1:${running.address.port}`;

    const page = await fetch(`${base}/admin`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /Elysian Admin/);

    const api = await fetch(`${base}/v1/admin/llm-config`);
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), {
      method: "GET",
      path: "/v1/admin/llm-config",
      body: null,
    });

    const emptyBodyPost = await fetch(`${base}/v1/admin/llm-config/test`, { method: "POST" });
    assert.equal(emptyBodyPost.status, 200, "admin POST must accept an empty body");
  } finally {
    await stopAgentService(running.server);
  }
});

test("token-protected admin rejects missing or wrong tokens and accepts the right one", async () => {
  const running = await startAgentService(
    { host: "127.0.0.1", port: 0 },
    { admin: { handler: echoHandler, page: "<html></html>", token: "secret-token" } },
  );
  try {
    const base = `http://127.0.0.1:${running.address.port}`;

    const noToken = await fetch(`${base}/v1/admin/llm-config`);
    assert.equal(noToken.status, 403);

    const wrongToken = await fetch(`${base}/v1/admin/llm-config`, {
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(wrongToken.status, 403);

    const pageNoToken = await fetch(`${base}/admin`);
    assert.equal(pageNoToken.status, 403, "the page itself is token-gated too");

    const rightToken = await fetch(`${base}/v1/admin/llm-config`, {
      headers: { authorization: "Bearer secret-token" },
    });
    assert.equal(rightToken.status, 200);
  } finally {
    await stopAgentService(running.server);
  }
});

test("admin routes unknown to the handler return 404", async () => {
  const silentHandler: AdminRequestHandler = () => Promise.resolve(undefined);
  const running = await startAgentService(
    { host: "127.0.0.1", port: 0 },
    { admin: { handler: silentHandler } },
  );
  try {
    const response = await fetch(
      `http://127.0.0.1:${running.address.port}/v1/admin/whatever`,
    );
    assert.equal(response.status, 404);

    const page = await fetch(`http://127.0.0.1:${running.address.port}/admin`);
    assert.equal(page.status, 404, "no page configured means an explicit 404");
  } finally {
    await stopAgentService(running.server);
  }
});
