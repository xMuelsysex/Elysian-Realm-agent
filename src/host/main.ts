// Realm host process entrypoint: one long-running process serving the chat
// page, the admin LLM configuration, and the tick scheduler over persisted
// world state. `npm run host` — the personal, stateful counterpart to the
// stateless `npm start` service.

import {
  parseAgentServiceConfig,
  startAgentService,
  stopAgentService,
  type AdminOptions,
} from "../service/agentService.js";
import { ADMIN_PAGE_HTML } from "../service/adminPage.js";
import { createConversationHub } from "../service/conversationBootstrap.js";
import { CHAT_PAGE_HTML } from "./chatPage.js";
import { createHostApiHandler } from "./hostApi.js";
import { RealmHost } from "./realmHost.js";
import { RealmStateStore } from "./realmState.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const TICK_CHECK_INTERVAL_MS = 60_000;

try {
  const config = parseAgentServiceConfig();
  const hub = createConversationHub();
  const dataDir = process.env.ELYSIAN_REALM_DATA ?? "./realm-data";
  const state = new RealmStateStore(dataDir);
  const host = new RealmHost(state, () => hub.getRunner(), { llm: () => hub.getLlm() });

  const adminToken = process.env.ELYSIAN_ADMIN_TOKEN;
  const extensionsAllowed = LOOPBACK_HOSTS.has(config.host) || adminToken !== undefined;
  if (!extensionsAllowed) {
    console.warn(
      "admin/chat interfaces disabled: binding to a non-loopback host requires ELYSIAN_ADMIN_TOKEN",
    );
  }
  const extension = (handler: AdminOptions["handler"], page: string): AdminOptions => ({
    handler,
    page,
    ...(adminToken ? { token: adminToken } : {}),
  });

  const running = await startAgentService(config, {
    conversationRunner: () => hub.getRunner(),
    ...(extensionsAllowed
      ? {
          admin: extension(hub.createAdminHandler(), ADMIN_PAGE_HTML),
          chat: extension(createHostApiHandler(host), CHAT_PAGE_HTML),
        }
      : {}),
  });

  const logTick = (tick: Awaited<ReturnType<RealmHost["tickIfPeriodChanged"]>>): void => {
    if (!tick) {
      return;
    }
    console.log(
      `tick: period=${tick.period}, ${tick.added} memories, ${tick.narratives} narrative(s), ${tick.reflections} reflection(s)`,
    );
    for (const note of tick.notes) {
      console.warn(`tick note: ${note}`);
    }
  };

  let firstTick: Awaited<ReturnType<RealmHost["tickIfPeriodChanged"]>>;
  try {
    firstTick = await host.tickIfPeriodChanged();
  } catch (error) {
    // A failed tick must not take the chat/admin surfaces down.
    console.error("startup tick failed", error);
  }
  const tickTimer = setInterval(() => {
    void host
      .tickIfPeriodChanged()
      .then(logTick)
      .catch((error) => console.error("tick failed", error));
  }, TICK_CHECK_INTERVAL_MS);

  const base = `http://${config.host}:${running.address.port}`;
  console.log(`elysian-realm host listening on ${base}`);
  console.log(`realm data: ${dataDir} (${state.config.agents.length} agent(s))`);
  logTick(firstTick);
  const status = hub.getStatus();
  console.log(
    status.configured
      ? `chat ready at ${base}/chat (llm: ${status.baseUrl ?? status.provider}/${status.model})`
      : `llm not configured — open ${base}/admin first, then chat at ${base}/chat`,
  );

  let shutdownStarted = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    clearInterval(tickTimer);

    try {
      state.persist();
      await stopAgentService(running.server);
      console.log(`elysian-realm host stopped after ${signal}`);
    } catch (error) {
      console.error("elysian-realm host shutdown failed", error);
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
} catch (error) {
  console.error("elysian-realm host failed to start", error);
  process.exitCode = 1;
}
