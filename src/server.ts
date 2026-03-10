import { buildApp } from "./app.js";
import { loadConfig, validateRuntimeConfig } from "./config.js";

async function start() {
  const config = await loadConfig();
  validateRuntimeConfig(config);
  const app = buildApp(config);

  const stop = async () => {
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    await app.listen({ port: config.server.port, host: config.server.host });
    app.log.info(
      {
        port: config.server.port,
        host: config.server.host,
        webhookPath: config.telegram.webhookPath,
        databasePath: config.database.path,
      },
      "server listening",
    );
  } catch (error) {
    app.log.error({ err: error }, "failed to start server");
    process.exit(1);
  }
}

start();
