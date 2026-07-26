import {
  parseAgentServiceConfig,
  startAgentService,
  stopAgentService,
  type AdminOptions,
} from "./agentService.js";
import { ADMIN_PAGE_HTML } from "./adminPage.js";
import { createConversationHub } from "./conversationBootstrap.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

try {
  const config = parseAgentServiceConfig();
  const hub = createConversationHub();

  // Admin gate decision lives here at the assembly point: loopback binds get
  // the admin interface as-is; non-loopback binds require an explicit token,
  // otherwise admin stays off and we say so instead of exposing it silently.
  const adminToken = process.env.ELYSIAN_ADMIN_TOKEN;
  let admin: AdminOptions | undefined;
  if (LOOPBACK_HOSTS.has(config.host) || adminToken) {
    admin = {
      handler: hub.createAdminHandler(),
      page: ADMIN_PAGE_HTML,
      ...(adminToken ? { token: adminToken } : {}),
    };
  } else {
    console.warn(
      "admin interface disabled: binding to a non-loopback host requires ELYSIAN_ADMIN_TOKEN",
    );
  }

  const running = await startAgentService(config, {
    conversationRunner: () => hub.getRunner(),
    ...(admin ? { admin } : {}),
  });
  console.log(
    `elysian-realm-agent listening on http://${running.address.address}:${running.address.port}`,
  );
  const status = hub.getStatus();
  console.log(
    status.configured
      ? `conversation endpoint enabled via ${status.provider}/${status.model} (config: ${status.configSource}, key: ${status.keySource})`
      : "conversation endpoint not configured" +
          (admin ? ` — open http://${config.host}:${running.address.port}/admin to set it up` : ""),
  );

  let shutdownStarted = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;

    try {
      await stopAgentService(running.server);
      console.log(`elysian-realm-agent stopped after ${signal}`);
    } catch (error) {
      console.error("elysian-realm-agent shutdown failed", error);
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
  console.error("elysian-realm-agent failed to start", error);
  process.exitCode = 1;
}
