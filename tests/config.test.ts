import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, validateRuntimeConfig, type AppConfig } from "../src/config.js";

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
    llm: {
      provider: "openai",
      model: "gpt-5-mini",
      embeddingModel: "text-embedding-3-small",
      apiKey: "test-api-key",
      baseUrl: "https://api.openai.com/v1",
      requestTimeoutMs: 15000,
      maxPromptChars: 4000,
      maxResponseTokens: 400,
      plannerMaxResponseTokens: 120,
      streamUpdateIntervalMs: 750,
    },
    telegram: {
      botToken: "telegram-token",
      webhookPath: "/telegram/webhook",
      webhookSecret: "",
      requestTimeoutMs: 5000,
      rateLimitWindowMs: 60000,
      rateLimitMaxRequests: 10,
    },
    liveLookup: {
      provider: "openai_search",
      apiKey: "test-api-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-search-preview",
      requestTimeoutMs: 5000,
      maxOutputTokens: 500,
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

test("validateRuntimeConfig rejects an invalid Telegram rate limit window", () => {
  const config = createValidConfig();
  config.telegram.rateLimitWindowMs = 0;

  assert.throws(
    () => validateRuntimeConfig(config),
    /telegram\.rateLimitWindowMs must be a positive integer/,
  );
});

test("validateRuntimeConfig rejects an invalid Telegram rate limit max requests", () => {
  const config = createValidConfig();
  config.telegram.rateLimitMaxRequests = 0;

  assert.throws(
    () => validateRuntimeConfig(config),
    /telegram\.rateLimitMaxRequests must be a positive integer/,
  );
});

test("validateRuntimeConfig rejects a missing llm api key", () => {
  const config = createValidConfig();
  config.llm.apiKey = "";

  assert.throws(
    () => validateRuntimeConfig(config),
    /llm\.apiKey or OPENAI_API_KEY is required/,
  );
});

test("validateRuntimeConfig rejects an invalid llm timeout", () => {
  const config = createValidConfig();
  config.llm.requestTimeoutMs = 0;

  assert.throws(
    () => validateRuntimeConfig(config),
    /llm\.requestTimeoutMs must be a positive integer/,
  );
});

test("validateRuntimeConfig rejects an invalid llm max response tokens", () => {
  const config = createValidConfig();
  config.llm.maxResponseTokens = 0;

  assert.throws(
    () => validateRuntimeConfig(config),
    /llm\.maxResponseTokens must be a positive integer/,
  );
});

test("validateRuntimeConfig rejects a missing live lookup api key when provider is enabled", () => {
  const config = createValidConfig();
  config.liveLookup.apiKey = "";

  assert.throws(
    () => validateRuntimeConfig(config),
    /liveLookup\.apiKey or OPENAI_API_KEY is required/,
  );
});

test("validateRuntimeConfig rejects an invalid live lookup max output tokens", () => {
  const config = createValidConfig();
  config.liveLookup.maxOutputTokens = 0;

  assert.throws(
    () => validateRuntimeConfig(config),
    /liveLookup\.maxOutputTokens must be a positive integer/,
  );
});

test("loadConfig strips surrounding quotes from env strings", async () => {
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalTelegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalLiveLookupModel = process.env.LIVE_LOOKUP_MODEL;

  process.env.OPENAI_API_KEY = "\"test-api-key\"";
  process.env.TELEGRAM_BOT_TOKEN = "\"telegram-token\"";
  process.env.LIVE_LOOKUP_MODEL = "\"gpt-4o-mini-search-preview\"";

  try {
    const config = await loadConfig("__missing_config_for_quote_test__.yaml");

    assert.equal(config.llm.apiKey, "test-api-key");
    assert.equal(config.telegram.botToken, "telegram-token");
    assert.equal(config.liveLookup.apiKey, "test-api-key");
    assert.equal(config.liveLookup.model, "gpt-4o-mini-search-preview");
  } finally {
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }

    if (originalTelegramBotToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = originalTelegramBotToken;
    }

    if (originalLiveLookupModel === undefined) {
      delete process.env.LIVE_LOOKUP_MODEL;
    } else {
      process.env.LIVE_LOOKUP_MODEL = originalLiveLookupModel;
    }
  }
});
