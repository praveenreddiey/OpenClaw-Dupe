import test from "node:test";
import assert from "node:assert/strict";
import { validateRuntimeConfig, type AppConfig } from "../src/config.js";

function createValidConfig(): AppConfig {
  return {
    server: {
      host: "127.0.0.1",
      port: 3000,
    },
    logger: {
      level: "info",
    },
    database: {
      path: "./data/test.db",
    },
    telegram: {
      botToken: "telegram-token",
      webhookPath: "/telegram/webhook",
      webhookSecret: "",
      requestTimeoutMs: 5000,
    },
  };
}

test("validateRuntimeConfig accepts a valid Telegram runtime config", () => {
  assert.doesNotThrow(() => validateRuntimeConfig(createValidConfig()));
});

test("validateRuntimeConfig rejects an empty Telegram bot token", () => {
  const config = createValidConfig();
  config.telegram.botToken = "";

  assert.throws(
    () => validateRuntimeConfig(config),
    /telegram\.botToken is required/,
  );
});

test("validateRuntimeConfig rejects an invalid Telegram timeout", () => {
  const config = createValidConfig();
  config.telegram.requestTimeoutMs = 0;

  assert.throws(
    () => validateRuntimeConfig(config),
    /telegram\.requestTimeoutMs must be a positive integer/,
  );
});
