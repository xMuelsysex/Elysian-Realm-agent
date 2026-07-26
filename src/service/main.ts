import {
  parseAgentServiceConfig,
  startAgentService,
  stopAgentService,
} from "./agentService.js";
import { createConversationRunnerFromEnv } from "./conversationBootstrap.js";

try {
  const config = parseAgentServiceConfig();
  const conversationRunner = createConversationRunnerFromEnv();
  const running = await startAgentService(
    config,
    conversationRunner ? { conversationRunner } : {},
  );
  console.log(
    `elysian-realm-agent listening on http://${running.address.address}:${running.address.port}`,
  );
  console.log(
    conversationRunner
      ? `conversation endpoint enabled via ${process.env.ELYSIAN_LLM_PROVIDER}/${process.env.ELYSIAN_LLM_MODEL}`
      : "conversation endpoint disabled (set ELYSIAN_LLM_PROVIDER and ELYSIAN_LLM_MODEL to enable)",
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
