import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    skills: {
      enabled: true,
      timeoutMs: 2000,
      maxOldGenerationSizeMb: 64,
      maxReadBytes: 65536,
      maxWriteBytes: 65536,
      allowedPaths: ["./"],
      blockedPaths: ["./.env", "./config.yaml", "./.git", "./node_modules", "./dist"],
      shellEnabled: true,
      shellWorkingDirectory: "./",
      shellMaxOutputBytes: 16384,
      shellAllowlist: [
        {
          command: "git status --short",
          requiresConfirmation: false,
        },
        {
          command: "npm run build",
          requiresConfirmation: true,
        },
      ],
    },
    scheduler: {
      enabled: false,
      pollIntervalMs: 10000,
      runTimeoutMs: 30000,
      rateLimitWindowMs: 60000,
      rateLimitMaxRuns: 2,
      tasks: [],
    },
    viewer: {
      enabled: true,
      path: "/logs",
      taskRunLimit: 25,
      auditLogLimit: 50,
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

test("validateRuntimeConfig rejects a filesystem root in skills.allowedPaths", () => {
  const config = createValidConfig();
  config.skills.allowedPaths = [path.parse(process.cwd()).root];

  assert.throws(
    () => validateRuntimeConfig(config),
    /skills\.allowedPaths must not include a filesystem root/,
  );
});

test("validateRuntimeConfig rejects an invalid skills timeout", () => {
  const config = createValidConfig();
  config.skills.timeoutMs = 0;

  assert.throws(
    () => validateRuntimeConfig(config),
    /skills\.timeoutMs must be a positive integer/,
  );
});

test("validateRuntimeConfig accepts ollama without an api key", () => {
  const config = createValidConfig();
  config.llm.provider = "ollama";
  config.llm.apiKey = "";
  config.llm.baseUrl = "http://127.0.0.1:11434";
  config.llm.embeddingModel = "nomic-embed-text";

  assert.doesNotThrow(() => validateRuntimeConfig(config));
});

test("validateRuntimeConfig rejects shell allowlist entries that skip confirmation for mutating commands", () => {
  const config = createValidConfig();
  config.skills.shellAllowlist = [
    {
      command: "npm run build",
      requiresConfirmation: false,
    },
  ];

  assert.throws(
    () => validateRuntimeConfig(config),
    /must require confirmation/i,
  );
});

test("validateRuntimeConfig rejects blank scheduler telegram chat ids", () => {
  const config = createValidConfig();
  config.scheduler.tasks = [
    {
      name: "heartbeat",
      schedule: "*/2 * * * *",
      prompt: "Say hello",
      enabled: true,
      maxOutputTokens: 80,
      telegramChatId: "   ",
    },
  ];

  assert.throws(
    () => validateRuntimeConfig(config),
    /telegramChatId must be a non-empty string/i,
  );
});

test("validateRuntimeConfig rejects runOnce scheduler tasks without telegram chat ids", () => {
  const config = createValidConfig();
  config.scheduler.tasks = [
    {
      name: "once-reminder",
      schedule: "* * * * *",
      prompt: "Send one message",
      enabled: true,
      maxOutputTokens: 1,
      runOnce: true,
    },
  ];

  assert.throws(
    () => validateRuntimeConfig(config),
    /runOnce requires telegramChatId/i,
  );
});

test("loadConfig reads scheduler task telegram chat ids", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "claw-dupe-config-"));
  const configPath = path.join(directory, "config.yaml");

  try {
    await writeFile(
      configPath,
      `
telegram:
  botToken: "telegram-token"

llm:
  provider: "openai"
  apiKey: "test-api-key"

liveLookup:
  provider: "openai_search"
  apiKey: "test-api-key"

scheduler:
  tasks:
    - name: "heartbeat"
      schedule: "*/2 * * * *"
      prompt: "Say hello"
      enabled: true
      maxOutputTokens: 80
      telegramChatId: "chat-42"
`,
      "utf8",
    );

    const config = await loadConfig(configPath);

    assert.equal(config.scheduler.tasks.length, 1);
    assert.equal(config.scheduler.tasks[0]?.telegramChatId, "chat-42");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
