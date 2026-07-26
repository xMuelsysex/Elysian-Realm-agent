import {
  parseAgentServiceConfig,
  startAgentService,
  stopAgentService,
} from "./agentService.js";

try {
  const config = parseAgentServiceConfig();
  const running = await startAgentService(config);
  console.log(
    `elysian-realm-agent listening on http://${running.address.address}:${running.address.port}`,
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
