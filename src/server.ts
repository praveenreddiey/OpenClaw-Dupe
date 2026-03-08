import Fastify from "fastify";
import { loadConfig } from "./config.js";

async function start() {
  const config = await loadConfig();

  // Fastify v5 expects logger to be a config object (not a pino instance)
  const app = Fastify({
    logger: {
      level: config.logger.level,
    },
  });

  app.get("/health", async () => ({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

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
      { port: config.server.port, host: config.server.host },
      "server listening",
    );
  } catch (err) {
    app.log.error(err, "failed to start server");
    process.exit(1);
  }
}

start();
