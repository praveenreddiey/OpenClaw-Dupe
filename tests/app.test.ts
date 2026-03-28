import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildApp,
  createTelegramClient,
  LlmRequestError,
  TelegramDeliveryError,
  type LlmClient,
  type TelegramClient,
} from "../src/app.js";
import type { LlmGenerateRequest, LlmStreamRequest } from "../src/llm.js";
import type { AppConfig } from "../src/config.js";
import { createMessageStore } from "../src/db.js";
import { encodeStaticReminderPrompt } from "../src/reminders.js";
import type { SkillRunner } from "../src/skill-runner.js";

function getRequestTarget(
  request: Parameters<SkillRunner["execute"]>[0],
): string {
  return "path" in request ? request.path : request.command;
}

function createTestConfig(databasePath: string): AppConfig {
  return {
    server: {
      host: "127.0.0.1",
      port: 3000,
    },
    logger: {
      level: "silent",
    },
    database: {
      path: databasePath,
    },
    llm: {
      provider: "openai",
      model: "gpt-5-mini",
      embeddingModel: "text-embedding-3-small",
      apiKey: "test-api-key",
      baseUrl: "https://api.openai.com/v1",
      requestTimeoutMs: 5000,
      maxPromptChars: 4000,
      maxResponseTokens: 400,
      plannerMaxResponseTokens: 120,
      streamUpdateIntervalMs: 1,
    },
    telegram: {
      botToken: "",
      webhookPath: "/telegram/webhook",
      webhookSecret: "secret-token",
      requestTimeoutMs: 5000,
      rateLimitWindowMs: 60000,
      rateLimitMaxRequests: 10,
    },
    liveLookup: {
      provider: "none",
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

function createTempDatabasePath(): { filePath: string; cleanup: () => void } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "claw-dupe-app-"));
  return {
    filePath: path.join(directory, "messages.db"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

async function waitForCondition(
  assertion: () => void,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for condition");
}

test("telegram webhook acknowledges quickly and streams an llm reply through Telegram edits", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const plannerRequests: LlmGenerateRequest[] = [];
  const streamRequests: LlmStreamRequest[] = [];
  const sentMessages: Array<{ chatId: string; text: string; replyToMessageId?: number }> = [];
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];

  const telegramClient: TelegramClient = {
    async sendMessage(input) {
      sentMessages.push(input);
      return {
        delivered: true,
        messageId: 9001,
        payloadJson: JSON.stringify({ ok: true, result: { message_id: 9001 } }),
      };
    },
    async editMessageText(input) {
      editedMessages.push(input);
      return {
        delivered: true,
        messageId: input.messageId,
        payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
      };
    },
  };

  const llmClient: LlmClient = {
    async generate(request) {
      plannerRequests.push(request);
      return {
        model: "gpt-5-mini",
        text: JSON.stringify({
          intent: "answer_question",
          objective: "Answer the user directly",
          replyStyle: "concise",
          mentionLimits: false,
        }),
      };
    },
    async *stream(request) {
      streamRequests.push(request);
      yield {
        type: "text-delta",
        delta: "Hello",
      };
      yield {
        type: "text-delta",
        delta: " from the LLM",
      };
      yield {
        type: "completed",
        text: "Hello from the LLM",
        model: "gpt-5-mini",
      };
    },
    async embeddings() {
      return {
        model: "text-embedding-3-small",
        vectors: [[0.1, 0.2]],
      };
    },
  };

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient,
    llmClient,
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 1,
        message: {
          message_id: 77,
          text: "hello bot",
          date: 1_710_238_800,
          chat: {
            id: 123456,
          },
          from: {
            id: 444,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      accepted: true,
    });

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("123456");
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.status, "processed");
      assert.equal(messages[1]?.status, "processed");
      assert.equal(messages[1]?.text, "Hello from the LLM");
    });

    assert.deepEqual(sentMessages, [
      {
        chatId: "123456",
        text: "Thinking...",
        replyToMessageId: 77,
      },
    ]);
    assert.ok(
      editedMessages.some((message) => message.text === "Hello from the LLM"),
    );

    assert.equal(plannerRequests.length, 1);
    assert.equal(plannerRequests[0]?.messages[0]?.role, "system");
    assert.equal(plannerRequests[0]?.messages[1]?.role, "user");
    assert.ok(plannerRequests[0]?.messages[1]?.content.includes("hello bot"));
    assert.ok(!plannerRequests[0]?.messages[0]?.content.includes("hello bot"));

    assert.equal(streamRequests.length, 1);
    assert.equal(streamRequests[0]?.messages[0]?.role, "system");
    assert.equal(streamRequests[0]?.messages[1]?.role, "user");
    assert.equal(streamRequests[0]?.maxOutputTokens, 1000);

    const messages = store.listMessagesByChat("123456");
    assert.equal(messages[0]?.userId, "444");
    assert.equal(messages[0]?.telegramMessageId, 77);
    assert.equal(messages[1]?.telegramMessageId, 9001);
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook executes fs_read skill requests without using the llm path", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const sentMessages: Array<{ chatId: string; text: string; replyToMessageId?: number }> = [];
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
  const observedRequests: Array<{ skillName: string; path: string }> = [];

  const skillRunner: SkillRunner = {
    async execute(request) {
      observedRequests.push({
        skillName: request.skillName,
        path: getRequestTarget(request),
      });

      return {
        success: true,
        output: "# Claw Dupe\n\nDevelopers: read AGENTS.md before making changes.",
        error: null,
        meta: {
          skillName: request.skillName,
          targetPath: "README.md",
          durationMs: 5,
          resultSize: 63,
        },
      };
    },
  };

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage(input) {
        sentMessages.push(input);
        return {
          delivered: true,
          messageId: 9010,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9010 } }),
        };
      },
      async editMessageText(input) {
        editedMessages.push(input);
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    skillRunner,
    llmClient: {
      async generate() {
        throw new Error("generate should not be called for direct skill requests");
      },
      async *stream() {
        throw new Error("stream should not be called for direct skill requests");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 7001,
        message: {
          message_id: 144,
          text: "/fs_read README.md",
          chat: {
            id: 123456,
          },
          from: {
            id: 654321,
          },
          date: 1_700_000_000,
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      assert.equal(observedRequests.length, 1);
      assert.deepEqual(observedRequests[0], {
        skillName: "fs_read",
        path: "README.md",
      });
      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0]?.text, "Thinking...");
      assert.equal(editedMessages.length, 1);
      assert.match(editedMessages[0]?.text ?? "", /success: true/);
      assert.match(editedMessages[0]?.text ?? "", /Developers: read AGENTS\.md/);
    });

    const messages = store.listMessagesByChat("123456");
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.status, "processed");
    assert.equal(messages[1]?.status, "processed");
    assert.match(messages[1]?.text ?? "", /success: true/);
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook maps natural-language save requests to fs_write", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const observedRequests: Array<{ skillName: string; path: string; content?: string }> = [];
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9011,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9011 } }),
        };
      },
      async editMessageText(input) {
        editedMessages.push(input);
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    skillRunner: {
      async execute(request) {
        observedRequests.push({
          skillName: request.skillName,
          path: getRequestTarget(request),
          content: "content" in request ? request.content : undefined,
        });

        return {
          success: true,
          output: "Wrote 10 bytes to name.txt.",
          error: null,
          meta: {
            skillName: request.skillName,
            targetPath: getRequestTarget(request),
            durationMs: 4,
            resultSize: 24,
          },
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called for direct skill requests");
      },
      async *stream() {
        throw new Error("stream should not be called for direct skill requests");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 7002,
        message: {
          message_id: 145,
          text: "Save file name as name.txt Content is hi praveen",
          chat: {
            id: 123456,
          },
          from: {
            id: 654321,
          },
          date: 1_700_000_001,
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      assert.equal(observedRequests.length, 1);
      assert.deepEqual(observedRequests[0], {
        skillName: "fs_write",
        path: "name.txt",
        content: "hi praveen",
      });
      assert.equal(editedMessages.length, 1);
      assert.match(editedMessages[0]?.text ?? "", /success: true/);
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook maps natural-language read requests to fs_read", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const observedRequests: Array<{ skillName: string; path: string }> = [];

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9012,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9012 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    skillRunner: {
      async execute(request) {
        observedRequests.push({
          skillName: request.skillName,
          path: getRequestTarget(request),
        });

        return {
          success: true,
          output: "hello from name.txt",
          error: null,
          meta: {
            skillName: request.skillName,
            targetPath: getRequestTarget(request),
            durationMs: 3,
            resultSize: 18,
          },
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called for direct skill requests");
      },
      async *stream() {
        throw new Error("stream should not be called for direct skill requests");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 7003,
        message: {
          message_id: 146,
          text: "Read file name.txt",
          chat: {
            id: 123456,
          },
          from: {
            id: 654321,
          },
          date: 1_700_000_002,
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      assert.equal(observedRequests.length, 1);
      assert.deepEqual(observedRequests[0], {
        skillName: "fs_read",
        path: "name.txt",
      });
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook creates a scheduled reminder from natural language", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
  const config = createTestConfig(temp.filePath);
  config.scheduler.enabled = true;

  const app = buildApp(config, {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9014,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9014 } }),
        };
      },
      async editMessageText(input) {
        editedMessages.push(input);
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called for reminder creation");
      },
      async *stream() {
        throw new Error("stream should not be called for reminder creation");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 7004,
        message: {
          message_id: 147,
          text: "remind me every 2 minutes to drink water",
          chat: {
            id: 123456,
          },
          from: {
            id: 654321,
          },
          date: 1_700_000_003,
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      assert.equal(editedMessages.length, 1);
      assert.match(editedMessages[0]?.text ?? "", /Created reminder for every 2 minutes/i);
      assert.match(editedMessages[0]?.text ?? "", /Reminder: drink water/);
      assert.doesNotMatch(editedMessages[0]?.text ?? "", /^success:/m);

      const tasks = store.listScheduledTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.schedule, "*/2 * * * *");
      assert.equal(tasks[0]?.telegramChatId, "123456");
      assert.equal(tasks[0]?.enabled, true);
      assert.equal(tasks[0]?.prompt, "[[static-reminder]] Reminder: drink water");
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook creates a recurring reminder from set-a-remainder phrasing", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
  const config = createTestConfig(temp.filePath);
  config.scheduler.enabled = true;

  const app = buildApp(config, {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9023,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9023 } }),
        };
      },
      async editMessageText(input) {
        editedMessages.push(input);
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called for reminder creation");
      },
      async *stream() {
        throw new Error("stream should not be called for reminder creation");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 70045,
        message: {
          message_id: 145,
          text: "set a remainder to drink water every 2 minutes",
          chat: {
            id: 123456,
          },
          from: {
            id: 654321,
          },
          date: 1_700_000_045,
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      assert.equal(editedMessages.length, 1);
      assert.match(editedMessages[0]?.text ?? "", /Created reminder for every 2 minutes/i);
      assert.match(editedMessages[0]?.text ?? "", /Reminder: drink water/);
      assert.doesNotMatch(editedMessages[0]?.text ?? "", /^success:/m);

      const tasks = store.listScheduledTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.schedule, "*/2 * * * *");
      assert.equal(tasks[0]?.telegramChatId, "123456");
      assert.equal(tasks[0]?.enabled, true);
      assert.equal(tasks[0]?.prompt, "[[static-reminder]] Reminder: drink water");
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook updates the same reminder when the interval changes", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const config = createTestConfig(temp.filePath);
  config.scheduler.enabled = true;

  const app = buildApp(config, {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9015,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9015 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called for reminder creation");
      },
      async *stream() {
        throw new Error("stream should not be called for reminder creation");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const firstResponse = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 7005,
        message: {
          message_id: 148,
          text: "remind me every 2 minutes to drink water",
          chat: {
            id: 123456,
          },
          from: {
            id: 654321,
          },
          date: 1_700_000_004,
        },
      },
    });
    assert.equal(firstResponse.statusCode, 200);

    const secondResponse = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 7006,
        message: {
          message_id: 149,
          text: "remind me every 10 minutes to drink water",
          chat: {
            id: 123456,
          },
          from: {
            id: 654321,
          },
          date: 1_700_000_005,
        },
      },
    });
    assert.equal(secondResponse.statusCode, 200);

    await waitForCondition(() => {
      const tasks = store.listScheduledTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.schedule, "*/10 * * * *");
      assert.equal(tasks[0]?.telegramChatId, "123456");
      assert.equal(tasks[0]?.prompt, "[[static-reminder]] Reminder: drink water");
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook creates a one-time reminder from natural language", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
  const config = createTestConfig(temp.filePath);
  config.scheduler.enabled = true;

  const app = buildApp(config, {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9016,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9016 } }),
        };
      },
      async editMessageText(input) {
        editedMessages.push(input);
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called for reminder creation");
      },
      async *stream() {
        throw new Error("stream should not be called for reminder creation");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 7007,
        message: {
          message_id: 150,
          text: "remind me to send email in 1 minute",
          chat: {
            id: 123456,
          },
          from: {
            id: 654321,
          },
          date: 1_700_000_006,
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      assert.equal(editedMessages.length, 1);
      assert.match(editedMessages[0]?.text ?? "", /one-time reminder in 1 minute/i);
      assert.match(editedMessages[0]?.text ?? "", /Reminder: send email/);
      assert.doesNotMatch(editedMessages[0]?.text ?? "", /^success:/m);

      const tasks = store.listScheduledTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.runOnce, true);
      assert.equal(tasks[0]?.telegramChatId, "123456");
      assert.equal(tasks[0]?.enabled, true);
      assert.equal(tasks[0]?.prompt, "[[static-reminder]] Reminder: send email");
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook creates an exact clock-time reminder from natural language", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
  const config = createTestConfig(temp.filePath);
  config.scheduler.enabled = true;

  const app = buildApp(config, {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9017,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9017 } }),
        };
      },
      async editMessageText(input) {
        editedMessages.push(input);
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called for reminder creation");
      },
      async *stream() {
        throw new Error("stream should not be called for reminder creation");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 7008,
        message: {
          message_id: 151,
          text: "remind me at 2pm to send email",
          chat: {
            id: 123456,
          },
          from: {
            id: 654321,
          },
          date: 1_700_000_007,
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      assert.equal(editedMessages.length, 1);
      assert.match(editedMessages[0]?.text ?? "", /one-time reminder at 2:00 PM/i);
      assert.match(editedMessages[0]?.text ?? "", /Reminder: send email/);
      assert.doesNotMatch(editedMessages[0]?.text ?? "", /^success:/m);

      const tasks = store.listScheduledTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.runOnce, true);
      assert.equal(tasks[0]?.telegramChatId, "123456");
      assert.equal(tasks[0]?.enabled, true);
      assert.equal(tasks[0]?.prompt, "[[static-reminder]] Reminder: send email");
      assert.equal(tasks[0]?.schedule, "* * * * *");
      assert.notEqual(tasks[0]?.nextRunAt, null);
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook creates a reminder from set-a-reminder phrasing with IST", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
  const config = createTestConfig(temp.filePath);
  config.scheduler.enabled = true;

  const app = buildApp(config, {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9018,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9018 } }),
        };
      },
      async editMessageText(input) {
        editedMessages.push(input);
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called for reminder creation");
      },
      async *stream() {
        throw new Error("stream should not be called for reminder creation");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 7009,
        message: {
          message_id: 152,
          text: "set a remainder at 2:36pm IST to go to shopping",
          chat: {
            id: 123456,
          },
          from: {
            id: 654321,
          },
          date: 1_700_000_008,
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      assert.equal(editedMessages.length, 1);
      assert.match(editedMessages[0]?.text ?? "", /one-time reminder at 2:36 PM/i);
      assert.match(editedMessages[0]?.text ?? "", /Reminder: go to shopping/);
      const tasks = store.listScheduledTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.runOnce, true);
      assert.equal(tasks[0]?.prompt, "[[static-reminder]] Reminder: go to shopping");
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook creates a reminder from set-the-remainder phrasing", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
  const config = createTestConfig(temp.filePath);
  config.scheduler.enabled = true;

  const app = buildApp(config, {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9022,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9022 } }),
        };
      },
      async editMessageText(input) {
        editedMessages.push(input);
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called for reminder creation");
      },
      async *stream() {
        throw new Error("stream should not be called for reminder creation");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 7014,
        message: {
          message_id: 157,
          text: "set the remainder at 2:54pm to go shopping",
          chat: {
            id: 123456,
          },
          from: {
            id: 654321,
          },
          date: 1_700_000_013,
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      assert.equal(editedMessages.length, 1);
      assert.match(editedMessages[0]?.text ?? "", /one-time reminder at 2:54 PM/i);
      assert.match(editedMessages[0]?.text ?? "", /Reminder: go shopping/);
      const tasks = store.listScheduledTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.runOnce, true);
      assert.equal(tasks[0]?.prompt, "[[static-reminder]] Reminder: go shopping");
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook creates an exact-date reminder from natural language", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
  const config = createTestConfig(temp.filePath);
  config.scheduler.enabled = true;

  const app = buildApp(config, {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9021,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9021 } }),
        };
      },
      async editMessageText(input) {
        editedMessages.push(input);
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called for reminder creation");
      },
      async *stream() {
        throw new Error("stream should not be called for reminder creation");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 7013,
        message: {
          message_id: 156,
          text: "remind me on 31 March 2099 at 2pm to send email",
          chat: {
            id: 123456,
          },
          from: {
            id: 654321,
          },
          date: 1_700_000_012,
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      assert.equal(editedMessages.length, 1);
      assert.match(editedMessages[0]?.text ?? "", /one-time reminder on 31 March 2099 at 2:00 PM/i);
      assert.match(editedMessages[0]?.text ?? "", /Reminder: send email/);
      const tasks = store.listScheduledTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.runOnce, true);
      assert.equal(tasks[0]?.prompt, "[[static-reminder]] Reminder: send email");
      assert.match(tasks[0]?.nextRunAt ?? "", /^2099-03-31T/);
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook lists active reminders for the current chat", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
  const config = createTestConfig(temp.filePath);
  config.scheduler.enabled = true;

  store.upsertScheduledTask({
    name: "reminder-123456-send-email",
    schedule: "*/10 * * * *",
    prompt: encodeStaticReminderPrompt("send email"),
    enabled: true,
    maxOutputTokens: 1,
    telegramChatId: "123456",
    runOnce: false,
    nextRunAt: "2026-03-28T08:40:00.000Z",
  });
  store.upsertScheduledTask({
    name: "reminder-once-123456-drink-water",
    schedule: "* * * * *",
    prompt: encodeStaticReminderPrompt("drink water"),
    enabled: true,
    maxOutputTokens: 1,
    telegramChatId: "123456",
    runOnce: true,
    nextRunAt: "2026-03-28T09:00:00.000Z",
  });
  store.upsertScheduledTask({
    name: "report-task",
    schedule: "*/30 * * * *",
    prompt: "plain scheduler task",
    enabled: true,
    maxOutputTokens: 50,
    telegramChatId: "123456",
    runOnce: false,
    nextRunAt: "2026-03-28T10:00:00.000Z",
  });

  const app = buildApp(config, {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9019,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9019 } }),
        };
      },
      async editMessageText(input) {
        editedMessages.push(input);
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called for reminder listing");
      },
      async *stream() {
        throw new Error("stream should not be called for reminder listing");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 7010,
        message: {
          message_id: 153,
          text: "list the remainders",
          chat: {
            id: 123456,
          },
          from: {
            id: 654321,
          },
          date: 1_700_000_009,
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      assert.equal(editedMessages.length, 1);
      const reply = editedMessages[0]?.text ?? "";
      assert.match(reply, /Your active reminders:/);
      assert.match(reply, /\[\d+\] Reminder: send email/);
      assert.match(reply, /\[\d+\] Reminder: drink water/);
      assert.doesNotMatch(reply, /plain scheduler task/);
      assert.doesNotMatch(reply, /^success:/m);
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook cancels reminders by id and text", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
  const config = createTestConfig(temp.filePath);
  config.scheduler.enabled = true;

  const reminderById = store.upsertScheduledTask({
    name: "reminder-123456-send-email",
    schedule: "*/10 * * * *",
    prompt: encodeStaticReminderPrompt("send email"),
    enabled: true,
    maxOutputTokens: 1,
    telegramChatId: "123456",
    runOnce: false,
    nextRunAt: "2026-03-28T08:40:00.000Z",
  });
  store.upsertScheduledTask({
    name: "reminder-once-123456-drink-water",
    schedule: "* * * * *",
    prompt: encodeStaticReminderPrompt("drink water"),
    enabled: true,
    maxOutputTokens: 1,
    telegramChatId: "123456",
    runOnce: true,
    nextRunAt: "2026-03-28T09:00:00.000Z",
  });

  const app = buildApp(config, {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9020,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9020 } }),
        };
      },
      async editMessageText(input) {
        editedMessages.push(input);
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called for reminder cancellation");
      },
      async *stream() {
        throw new Error("stream should not be called for reminder cancellation");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const cancelByIdResponse = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 7011,
        message: {
          message_id: 154,
          text: `/cancel_reminder ${reminderById.id}`,
          chat: {
            id: 123456,
          },
          from: {
            id: 654321,
          },
          date: 1_700_000_010,
        },
      },
    });

    assert.equal(cancelByIdResponse.statusCode, 200);

    const cancelByTextResponse = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 7012,
        message: {
          message_id: 155,
          text: "cancel reminder drink water",
          chat: {
            id: 123456,
          },
          from: {
            id: 654321,
          },
          date: 1_700_000_011,
        },
      },
    });

    assert.equal(cancelByTextResponse.statusCode, 200);

    await waitForCondition(() => {
      assert.equal(editedMessages.length, 2);
      assert.match(editedMessages[0]?.text ?? "", new RegExp(`Cancelled reminder \\[${reminderById.id}\\]`, "i"));
      assert.match(editedMessages[1]?.text ?? "", /Cancelled reminder \[\d+\]: Reminder: drink water/i);
      const tasks = store.listScheduledTasks();
      assert.ok(tasks.every((task) => task.enabled === false));
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook requires confirmation before executing mutating shell commands", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
  const observedRequests: string[] = [];

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9013,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9013 } }),
        };
      },
      async editMessageText(input) {
        editedMessages.push(input);
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    skillRunner: {
      async execute(request) {
        observedRequests.push(getRequestTarget(request));
        return {
          success: true,
          output: "build completed",
          error: null,
          meta: {
            skillName: request.skillName,
            targetPath: getRequestTarget(request),
            durationMs: 25,
            resultSize: 15,
          },
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called for direct skill requests");
      },
      async *stream() {
        throw new Error("stream should not be called for direct skill requests");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const firstResponse = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 7100,
        message: {
          message_id: 200,
          text: "/shell_exec npm run build",
          chat: {
            id: 123456,
          },
          from: {
            id: 654321,
          },
          date: 1_700_000_100,
        },
      },
    });

    assert.equal(firstResponse.statusCode, 200);

    let confirmationToken = "";
    await waitForCondition(() => {
      assert.equal(observedRequests.length, 0);
      const confirmationReply = editedMessages.find((message) =>
        /Confirmation required/i.test(message.text)
      );
      assert.ok(confirmationReply);
      const tokenMatch = confirmationReply?.text.match(/\/confirm_shell ([a-f0-9-]+)/i);
      assert.ok(tokenMatch?.[1]);
      confirmationToken = tokenMatch?.[1] ?? "";
    });

    const confirmResponse = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 7101,
        message: {
          message_id: 201,
          text: `/confirm_shell ${confirmationToken}`,
          chat: {
            id: 123456,
          },
          from: {
            id: 654321,
          },
          date: 1_700_000_101,
        },
      },
    });

    assert.equal(confirmResponse.statusCode, 200);

    await waitForCondition(() => {
      assert.deepEqual(observedRequests, ["npm run build"]);
      assert.ok(
        editedMessages.some((message) => /build completed/.test(message.text)),
      );
      const audits = store.listToolAuditLogs(5);
      assert.equal(audits.length, 1);
      assert.equal(audits[0]?.status, "completed");
      assert.equal(audits[0]?.commandText, "npm run build");
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook uses live lookup for year-specific requests before the normal llm path", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const sentMessages: Array<{ chatId: string; text: string; replyToMessageId?: number }> = [];
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage(input) {
        sentMessages.push(input);
        return {
          delivered: true,
          messageId: 9100,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9100 } }),
        };
      },
      async editMessageText(input) {
        editedMessages.push(input);
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called when live lookup succeeds");
      },
      async *stream() {
        throw new Error("stream should not be called when live lookup succeeds");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup() {
        return {
          answer: "Here are 2 verified 2025 picks:\n\n1. Example One (2025)\n2. Example Two (2025)",
          sources: [
            {
              title: "Example Source",
              url: "https://example.com",
            },
          ],
          rawText: "{\"answer\":\"Here are 2 verified 2025 picks\"}",
          model: "gpt-4o-mini-search-preview",
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 11,
        message: {
          message_id: 101,
          text: "suggest me good 2 movies to watch from english released in 2025",
          date: 1_710_238_800,
          chat: {
            id: 654321,
          },
          from: {
            id: 111,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      accepted: true,
    });

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("654321");
      assert.equal(messages.length, 2);
      assert.equal(messages[1]?.status, "processed");
      assert.equal(
        messages[1]?.text,
        [
          "Shortlist of movies from 2025:",
          "",
          "1) Example One (2025)",
          "2) Example Two (2025)",
        ].join("\n"),
      );
    });

    assert.deepEqual(sentMessages[0], {
      chatId: "654321",
      text: "Thinking...",
      replyToMessageId: 101,
    });
    assert.ok(editedMessages.some((message) => /Example One/.test(message.text)));
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook uses live lookup for movie-title metadata questions and short follow-ups", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const lookupInputs: string[] = [];

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9200,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9200 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called when live lookup succeeds");
      },
      async *stream() {
        throw new Error("stream should not be called when live lookup succeeds");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup(userText) {
        lookupInputs.push(userText);

        if (/which language movie is this/i.test(userText)) {
          return {
            answer: "Sentimental Value is a Norwegian-language film.",
            sources: [],
            rawText: "{\"answer\":\"Sentimental Value is a Norwegian-language film.\"}",
            model: "gpt-4o-mini-search-preview",
          };
        }

        return {
          answer: "Sentimental Value is a Norwegian film.",
          sources: [],
          rawText: "{\"answer\":\"Sentimental Value is a Norwegian film.\"}",
          model: "gpt-4o-mini-search-preview",
        };
      },
    },
  });

  try {
    const firstResponse = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 12,
        message: {
          message_id: 201,
          text: "is sentimental value a norwegian movie ?",
          date: 1_710_238_900,
          chat: {
            id: 654322,
          },
          from: {
            id: 222,
          },
        },
      },
    });

    assert.equal(firstResponse.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("654322");
      assert.equal(messages.length, 2);
      assert.equal(messages[1]?.status, "processed");
      assert.equal(messages[1]?.text, "Sentimental Value is a Norwegian film.");
    });

    const secondResponse = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 13,
        message: {
          message_id: 202,
          text: "then which language movie is this ?",
          date: 1_710_238_901,
          chat: {
            id: 654322,
          },
          from: {
            id: 222,
          },
        },
      },
    });

    assert.equal(secondResponse.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("654322");
      assert.equal(messages.length, 4);
      assert.equal(messages[3]?.status, "processed");
      assert.equal(messages[3]?.text, "Sentimental Value is a Norwegian-language film.");
    });

    assert.equal(lookupInputs.length, 2);
    assert.match(lookupInputs[0] ?? "", /is sentimental value a norwegian movie \?/i);
    assert.match(lookupInputs[1] ?? "", /<recent_conversation>/);
    assert.match(lookupInputs[1] ?? "", /is sentimental value a norwegian movie \?/i);
    assert.match(lookupInputs[1] ?? "", /then which language movie is this \?/i);
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook compacts verbose live recommendation replies into a short list", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9101,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9101 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called when live lookup succeeds");
      },
      async *stream() {
        throw new Error("stream should not be called when live lookup succeeds");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
        async lookup() {
          return {
            answer: [
              "Here are some of the best Netflix original TV shows from 2025:",
              "\"Adolescence\" (2025): An Emmy-winning crime drama with intense performances and a tense suburban school-murder investigation at the center. (tomsguide.com)",
              "- \"Last Samurai Standing\" (2025): A high-stakes Meiji-era survival series with sword duels, shifting alliances, and a relentless tournament setup. (tomsguide.com)",
              "- \"Toxic Town\" (2025): A gripping UK limited series about an environmental scandal and the families pushing back for justice. (tomsguide.com)",
              "- \"Forever\" (2025): A romantic teen drama about first love, messy timing, and emotionally grounded coming-of-age choices. (tomsguide.com)",
              "- \"The Eternaut\" (2025): An acclaimed sci-fi adaptation with apocalyptic snowfall, paranoia, and strong ensemble survival tension. (tomsguide.com)",
              "- \"Death by Lightning\" (2025): A political drama that revisits President Garfield's assassination with sharp period detail and intrigue. (tomsguide.com)",
            ].join(" "),
            sources: [],
            rawText: "{\"answer\":\"verbose\"}",
            model: "gpt-4o-mini-search-preview",
          };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 20,
        message: {
          message_id: 110,
          text: "best tv shows of 2025 netflix",
          date: 1_710_238_850,
          chat: {
            id: 700007,
          },
          from: {
            id: 338,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700007");
      assert.equal(messages.length, 2);
        assert.equal(
          messages[1]?.text,
          [
            "Shortlist of Netflix shows from 2025:",
            "",
            "1) Adolescence (2025) - An Emmy-winning crime drama with intense performances and a tense suburban school-murder investigation at the center",
            "2) Last Samurai Standing (2025) - A high-stakes Meiji-era survival series with sword duels, shifting alliances, and a relentless tournament setup",
            "3) Toxic Town (2025) - A gripping UK limited series about an environmental scandal and the families pushing back for justice",
            "4) Forever (2025) - A romantic teen drama about first love, messy timing, and emotionally grounded coming-of-age choices",
            "5) The Eternaut (2025) - An acclaimed sci-fi adaptation with apocalyptic snowfall, paranoia, and strong ensemble survival tension",
            "6) Death by Lightning (2025) - A political drama that revisits President Garfield's assassination with sharp period detail and intrigue",
          ].join("\n"),
        );
      });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook preserves notes from numbered live recommendation answers", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9102,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9102 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called when live lookup succeeds");
      },
      async *stream() {
        throw new Error("stream should not be called when live lookup succeeds");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup() {
        return {
          answer: [
            "Here are some highly-rated Korean thriller dramas based on IMDb ratings:",
            "1. **Mouse** (2021) – A rookie police officer is pulled into a serial-killer case with escalating moral twists. IMDb rating: 8.6/10.",
            "2. **Signal** (2016) – Detectives from different eras coordinate over a mysterious radio to solve cold cases. IMDb rating: 8.5/10.",
            "3. **Beyond Evil** (2021) – A slow-burn small-town murder thriller built on suspicion, secrets, and standout performances. IMDb rating: 8.1/10. These dramas are widely praised for their tension and performances.",
          ].join(" "),
          sources: [],
          rawText: "{\"answer\":\"numbered\"}",
          model: "gpt-4o-mini-search-preview",
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 21,
        message: {
          message_id: 111,
          text: "suggest me best korean dramas in thriller genre based on imdb",
          date: 1_710_238_851,
          chat: {
            id: 700008,
          },
          from: {
            id: 339,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700008");
      assert.equal(messages.length, 2);
      assert.equal(
        messages[1]?.text,
        [
          "Shortlist of shows:",
          "",
          "1) Mouse (2021) - A rookie police officer is pulled into a serial-killer case with escalating moral twists. IMDb rating: 8.6/10",
          "2) Signal (2016) - Detectives from different eras coordinate over a mysterious radio to solve cold cases. IMDb rating: 8.5/10",
          "3) Beyond Evil (2021) - A slow-burn small-town murder thriller built on suspicion, secrets, and standout performances. IMDb rating: 8.1/10",
        ].join("\n"),
      );
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook preserves multi-part recommendation replies without flattening them", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9103,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9103 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called when live lookup succeeds");
      },
      async *stream() {
        throw new Error("stream should not be called when live lookup succeeds");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup() {
        return {
          answer: [
            "1) Telugu 2025 pick: Paderu 12th Mile (2025) - Director: Nooka Sahib. Mystery thriller with a rural missing-person investigation hook. (en.wikipedia.org)",
            "For a similar 90s pick, consider 1) Money (1993) - A fast, twisty Telugu crime-comedy thriller with strong cult appeal.",
          ].join(" "),
          sources: [],
          rawText: "{\"answer\":\"multi-part\"}",
          model: "gpt-4o-mini-search-preview",
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 22,
        message: {
          message_id: 112,
          text: "I want to watch a movie. Suggest a Telugu thriller from 2025, tell me who the director is, and then suggest a similar movie from the 90s.",
          date: 1_710_238_852,
          chat: {
            id: 700009,
          },
          from: {
            id: 340,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700009");
      assert.equal(messages.length, 2);
      assert.equal(
        messages[1]?.text,
        [
          "1) Telugu 2025 pick: Paderu 12th Mile (2025) - Director: Nooka Sahib. Mystery thriller with a rural missing-person investigation hook.",
          "For a similar 90s pick, consider",
          "1) Money (1993) - A fast, twisty Telugu crime-comedy thriller with strong cult appeal.",
        ].join("\n"),
      );
      assert.doesNotMatch(messages[1]?.text ?? "", /Shortlist of movies from 2025/i);
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook normalizes obvious platform typos before live lookup", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const liveLookupInputs: string[] = [];

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9102,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9102 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called when live lookup succeeds");
      },
      async *stream() {
        throw new Error("stream should not be called when live lookup succeeds");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup(input) {
        liveLookupInputs.push(input);
        return {
          answer: "1. Reacher (2025)\n2. The Boys (2025)",
          sources: [],
          rawText: "{\"answer\":\"prime-video\"}",
          model: "gpt-4o-mini-search-preview",
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 21,
        message: {
          message_id: 111,
          text: "best tv shows of 2025 primw",
          date: 1_710_238_860,
          chat: {
            id: 700008,
          },
          from: {
            id: 339,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700008");
      assert.equal(messages.length, 2);
      assert.match(messages[1]?.text ?? "", /Reacher/i);
      assert.doesNotMatch(messages[1]?.text ?? "", /couldn't retrieve verified live data/i);
    });

    assert.equal(liveLookupInputs.length, 1);
    assert.equal(liveLookupInputs[0], "best tv shows of 2025 prime video");
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook includes recent chat context for short follow-up messages", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const plannerRequests: LlmGenerateRequest[] = [];
  let nonPlannerGenerateCount = 0;

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9140,
          payloadJson: JSON.stringify({ ok: true }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true }),
        };
      },
    },
    llmClient: {
      async generate(request) {
        if (request.responseFormat === "json_object") {
          plannerRequests.push(request);
          return {
            model: "gpt-5-mini",
            text: JSON.stringify({
              intent: "answer_question",
              objective: "Answer the user directly",
              replyStyle: "structured",
              mentionLimits: false,
            }),
          };
        }

        nonPlannerGenerateCount += 1;
        return {
          model: "gpt-5-mini",
          text: nonPlannerGenerateCount === 1
            ? "1. **Sacred Games (2018)** - Hindi | Netflix\n2. **Paatal Lok (2020)** - Hindi | Prime Video"
            : "Here are a few Malayalam TV shows to start with.",
        };
      },
      async *stream() {
        yield {
          type: "completed",
          text: "Here are a few Malayalam TV shows to start with.",
          model: "gpt-5-mini",
        };
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 21,
        message: {
          message_id: 201,
          text: "best tv shows in india",
          date: 1_710_238_800,
          chat: {
            id: 888001,
          },
          from: {
            id: 555,
          },
        },
      },
    });

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("888001");
      assert.equal(messages.length, 2);
      assert.match(messages[1]?.text ?? "", /Sacred Games/i);
    });

    await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 22,
        message: {
          message_id: 202,
          text: "malayalam",
          date: 1_710_238_810,
          chat: {
            id: 888001,
          },
          from: {
            id: 555,
          },
        },
      },
    });

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("888001");
      assert.equal(messages.length, 4);
      assert.match(messages[3]?.text ?? "", /Malayalam TV shows/i);
    });

    assert.equal(plannerRequests.length, 2);
    assert.match(plannerRequests[1]?.messages[1]?.content ?? "", /best tv shows in india/i);
    assert.match(plannerRequests[1]?.messages[1]?.content ?? "", /Sacred Games/i);
    assert.match(plannerRequests[1]?.messages[1]?.content ?? "", /malayalam/i);
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook strips unsolicited language highlight sections from broad recommendation replies", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9141,
          payloadJson: JSON.stringify({ ok: true }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true }),
        };
      },
    },
    llmClient: {
      async generate(request) {
        if (request.responseFormat === "json_object") {
          return {
            model: "gpt-5-mini",
            text: JSON.stringify({
              intent: "answer_question",
              objective: "Recommend TV shows in India",
              replyStyle: "structured",
              mentionLimits: false,
            }),
          };
        }

        return {
          model: "gpt-5-mini",
          text: [
            "Here’s a tight mix of top Indian TV/web shows (incl. Malayalam), all generally available on major OTTs in India:",
            "",
            "1. **Sacred Games (2018)** - Hindi | Netflix",
            "2. **Paatal Lok (2020)** - Hindi | Prime Video",
            "",
            "**Malayalam highlight:**",
            "3. **Kodevide (TV series, Asianet)** - Malayalam",
            "",
            "If you want, I can next narrow this to only Malayalam shows or only a specific genre.",
          ].join("\n"),
        };
      },
      async *stream() {
        throw new Error("stream should not be called for GPT-5 structured recommendations");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 23,
        message: {
          message_id: 203,
          text: "best tv shows in india",
          date: 1_710_238_820,
          chat: {
            id: 888002,
          },
          from: {
            id: 556,
          },
        },
      },
    });

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("888002");
      assert.equal(messages.length, 2);
      assert.doesNotMatch(messages[1]?.text ?? "", /Malayalam highlight/i);
      assert.doesNotMatch(messages[1]?.text ?? "", /Kodevide/i);
      assert.doesNotMatch(messages[1]?.text ?? "", /only Malayalam shows/i);
      assert.doesNotMatch(messages[1]?.text ?? "", /incl\. Malayalam/i);
      assert.match(messages[1]?.text ?? "", /Sacred Games/i);
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook keeps requested language-specific recommendations intact", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9142,
          payloadJson: JSON.stringify({ ok: true }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true }),
        };
      },
    },
    llmClient: {
      async generate(request) {
        if (request.responseFormat === "json_object") {
          return {
            model: "gpt-5-mini",
            text: JSON.stringify({
              intent: "answer_question",
              objective: "Recommend Malayalam TV shows",
              replyStyle: "structured",
              mentionLimits: false,
            }),
          };
        }

        return {
          model: "gpt-5-mini",
          text: [
            "Malayalam picks:",
            "1. **Karikku** - Malayalam",
            "2. **Perilloor Premier League** - Malayalam",
          ].join("\n"),
        };
      },
      async *stream() {
        throw new Error("stream should not be called for GPT-5 structured recommendations");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 24,
        message: {
          message_id: 204,
          text: "best malayalam tv shows",
          date: 1_710_238_830,
          chat: {
            id: 888003,
          },
          from: {
            id: 557,
          },
        },
      },
    });

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("888003");
      assert.equal(messages.length, 2);
      assert.match(messages[1]?.text ?? "", /Karikku/i);
      assert.match(messages[1]?.text ?? "", /Perilloor Premier League/i);
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook accepts strong live answers even when search annotations are absent", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9150,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9150 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called when live lookup returns a strong answer");
      },
      async *stream() {
        throw new Error("stream should not be called when live lookup returns a strong answer");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup() {
        return {
          answer: "Chennai is currently 28C with clear skies.",
          sources: [],
          rawText: "Chennai is currently 28C with clear skies.",
          model: "gpt-4o-mini-search-preview",
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 12,
        message: {
          message_id: 104,
          text: "tell me the weather of chennai now",
          date: 1_710_238_800,
          chat: {
            id: 700010,
          },
          from: {
            id: 444,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700010");
      assert.equal(messages.length, 2);
      assert.match(messages[1]?.text ?? "", /currently 28C with clear skies/i);
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook compacts verbose live factual answers into a concise reply", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9151,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9151 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called when live lookup returns a strong answer");
      },
      async *stream() {
        throw new Error("stream should not be called when live lookup returns a strong answer");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup() {
        return {
          answer: [
            "As of 3:54 PM IST on March 14, 2026, in Chennai, India, the weather is hazy sunshine with a temperature of 92°F (34°C).",
            "## Weather for Chennai, India: Current Conditions: Hazy sunshine, 92°F (34°C)",
            "Daily Forecast: Saturday, March 14: Low: 73°F (23°C), High: 95°F (35°C).",
            "Sunday, March 15: Low: 73°F (23°C), High: 94°F (35°C).",
          ].join(" "),
          sources: [],
          rawText: "{\"answer\":\"verbose-weather\"}",
          model: "gpt-4o-mini-search-preview",
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 121,
        message: {
          message_id: 1041,
          text: "weather in chennai now",
          date: 1_710_238_801,
          chat: {
            id: 700011,
          },
          from: {
            id: 445,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700011");
      assert.equal(messages.length, 2);
      assert.equal(
        messages[1]?.text,
        "As of 3:54 PM IST on March 14, 2026, in Chennai, India, the weather is hazy sunshine with a temperature of 92°F (34°C).",
      );
      assert.doesNotMatch(messages[1]?.text ?? "", /Daily Forecast|Sunday, March 15|##/i);
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook preserves longer latest-news replies without aggressive truncation", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9152,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9152 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called when live lookup returns a strong answer");
      },
      async *stream() {
        throw new Error("stream should not be called when live lookup returns a strong answer");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup() {
        return {
          answer: [
            "As of March 28, 2026, here are the latest developments in India across politics and policy.",
            "Political update: major coalition discussions continued in Delhi with new cabinet coordination talks.",
            "Economic update: markets reacted to inflation commentary and banking-sector policy signals.",
            "Infrastructure update: rail and metro expansion announcements were highlighted by multiple states.",
            "International update: regional diplomacy meetings focused on trade and border cooperation.",
          ].join(" "),
          sources: [],
          rawText: "{\"answer\":\"latest-news\"}",
          model: "gpt-4o-mini-search-preview",
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 122,
        message: {
          message_id: 1042,
          text: "what is the latest news in india today",
          date: 1_710_238_802,
          chat: {
            id: 700012,
          },
          from: {
            id: 446,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700012");
      assert.equal(messages.length, 2);
      const reply = messages[1]?.text ?? "";
      assert.match(reply, /As of March 28, 2026/i);
      assert.match(reply, /- Political update:/i);
      assert.match(reply, /- Economic update:/i);
      assert.match(reply, /- Infrastructure update:/i);
      assert.ok(reply.length > 320);
      assert.match(reply, /\n-\s+/);
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook does not fail-closed on a plain hi after a timed-out latest-news lookup", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9153,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9153 } }),
        };
      },
      async editMessageText(input) {
        editedMessages.push(input);
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        return {
          model: "gpt-5-mini",
          text: JSON.stringify({
            intent: "answer_question",
            objective: "Answer the user directly",
            replyStyle: "concise",
            mentionLimits: false,
          }),
        };
      },
      async *stream() {
        yield {
          type: "completed",
          text: "Hello!",
          model: "gpt-5-mini",
        };
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup() {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    },
  });

  try {
    const newsResponse = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 123,
        message: {
          message_id: 1043,
          text: "what is the latest news in india today",
          date: 1_710_238_803,
          chat: {
            id: 700013,
          },
          from: {
            id: 447,
          },
        },
      },
    });

    assert.equal(newsResponse.statusCode, 200);

    const hiResponse = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 124,
        message: {
          message_id: 1044,
          text: "hi",
          date: 1_710_238_804,
          chat: {
            id: 700013,
          },
          from: {
            id: 447,
          },
        },
      },
    });

    assert.equal(hiResponse.statusCode, 200);

    await waitForCondition(() => {
      assert.ok(editedMessages.length >= 2);
      const latestReply = editedMessages.at(-1)?.text ?? "";
      assert.equal(latestReply, "Hello!");
      assert.doesNotMatch(
        latestReply,
        /I couldn't retrieve verified live data right now, so I won't guess/i,
      );
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook does not fall back to the normal llm path for verified live weather requests", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9200,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9200 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called when verified live lookup fails");
      },
      async *stream() {
        throw new Error("stream should not be called when verified live lookup fails");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup() {
        return null;
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 12,
        message: {
          message_id: 102,
          text: "tell me the weather of chennai now",
          date: 1_710_238_800,
          chat: {
            id: 700001,
          },
          from: {
            id: 222,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700001");
      assert.equal(messages.length, 2);
      assert.match(messages[1]?.text ?? "", /couldn't retrieve verified live data/i);
      assert.doesNotMatch(messages[1]?.text ?? "", /google|weather\.com|accuweather/i);
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook falls back cleanly for weak live lookup answers on non-current ranking requests", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9300,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9300 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate(request) {
        if (request.responseFormat === "json_object") {
          return {
            model: "gpt-5-mini",
            text: JSON.stringify({
              intent: "answer_question",
              objective: "Recommend highly rated shows",
              replyStyle: "structured",
              mentionLimits: false,
            }),
          };
        }

        return {
          model: "gpt-5-mini",
          text: [
            "1. Breaking Bad (2008) - A crime thriller with relentless tension and top-tier performances.",
            "2. Chernobyl (2019) - A gripping disaster drama with a chilling investigative edge.",
          ].join("\n"),
        };
      },
      async *stream() {
        throw new Error("stream should not be called for GPT-5 structured recommendations");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup() {
        return {
          answer: "I can't access live IMDb right now, so check Google for the current top 5.",
          sources: [],
          rawText: "{\"answer\":\"weak\"}",
          model: "gpt-4o-mini-search-preview",
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 13,
        message: {
          message_id: 103,
          text: "top 5 shows based on imdb rating",
          date: 1_710_238_800,
          chat: {
            id: 700002,
          },
          from: {
            id: 333,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

      await waitForCondition(() => {
        const messages = store.listMessagesByChat("700002");
        assert.equal(messages.length, 2);
        assert.match(messages[1]?.text ?? "", /Breaking Bad/i);
        assert.doesNotMatch(messages[1]?.text ?? "", /couldn't retrieve verified live data/i);
        assert.doesNotMatch(messages[1]?.text ?? "", /check google|imdb right now/i);
      });
    } finally {
      await app.close();
      store.close();
    temp.cleanup();
  }
});

test("telegram webhook retries insufficient verified live list answers for current ranking requests", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const liveLookupInputs: string[] = [];

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 93001,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 93001 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called when live lookup succeeds after retry");
      },
      async *stream() {
        throw new Error("stream should not be called when live lookup succeeds after retry");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup(input) {
        liveLookupInputs.push(input);

        if (liveLookupInputs.length === 1) {
          return {
            answer: "Here are some highly-rated Korean thriller dramas based on IMDb ratings: 1. Mouse (2021) - A rookie police officer confronts a serial killer.",
            sources: [],
            rawText: "{\"answer\":\"single-item\"}",
            model: "gpt-4o-mini-search-preview",
          };
        }

        return {
          answer: [
            "1. Mouse (2021) - A tense cat-and-mouse thriller about a rookie cop and a serial-killer case.",
            "2. Beyond Evil (2021) - A slow-burn psychological thriller built on suspicion and layered performances.",
            "3. Flower of Evil (2020) - A gripping marital thriller with hidden identities and escalating danger.",
          ].join("\n"),
          sources: [],
          rawText: "{\"answer\":\"multi-item\"}",
          model: "gpt-4o-mini-search-preview",
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 130,
        message: {
          message_id: 1303,
          text: "current top 5 shows based on imdb rating",
          date: 1_710_238_900,
          chat: {
            id: 700021,
          },
          from: {
            id: 346,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700021");
      assert.equal(messages.length, 2);
      assert.equal(
        messages[1]?.text,
        [
          "Shortlist of shows:",
          "",
          "1) Mouse (2021) - A tense cat-and-mouse thriller about a rookie cop and a serial-killer case",
          "2) Beyond Evil (2021) - A slow-burn psychological thriller built on suspicion and layered performances",
          "3) Flower of Evil (2020) - A gripping marital thriller with hidden identities and escalating danger",
        ].join("\n"),
      );
    });

    assert.equal(liveLookupInputs.length, 2);
    assert.match(liveLookupInputs[1] ?? "", /verified numbered list with at least 2 items/i);
    assert.match(liveLookupInputs[1] ?? "", /reputable current sources that clearly cite imdb/i);
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook falls back to a shortlist for source-based genre catalog requests when live lookup is unavailable", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 93002,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 93002 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate(request) {
        if (request.responseFormat === "json_object") {
          return {
            model: "gpt-5-mini",
            text: JSON.stringify({
              intent: "answer_question",
              objective: "Recommend Korean thriller dramas",
              replyStyle: "structured",
              mentionLimits: false,
            }),
          };
        }

        return {
          model: "gpt-5-mini",
          text: [
            "1. Mouse (2021) - A dark serial-killer thriller with escalating moral twists.",
            "2. Beyond Evil (2021) - A slow-burn psychological thriller with layered suspects.",
            "3. Flower of Evil (2020) - A tense identity thriller built around a marriage and hidden past.",
          ].join("\n"),
        };
      },
      async *stream() {
        throw new Error("stream should not be called for GPT-5 structured recommendations");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup() {
        return null;
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 131,
        message: {
          message_id: 1304,
          text: "suggest me best korean dramas in thriller genre based on imdb",
          date: 1_710_238_901,
          chat: {
            id: 700022,
          },
          from: {
            id: 347,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700022");
      assert.equal(messages.length, 2);
      assert.equal(
        messages[1]?.text,
        [
          "Shortlist of shows:",
          "",
          "1) Mouse (2021) - A dark serial-killer thriller with escalating moral twists",
          "2) Beyond Evil (2021) - A slow-burn psychological thriller with layered suspects",
          "3) Flower of Evil (2020) - A tense identity thriller built around a marriage and hidden past",
        ].join("\n"),
      );
      assert.doesNotMatch(messages[1]?.text ?? "", /couldn't retrieve verified live data/i);
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook falls back cleanly for year-specific song requests when live lookup is unavailable", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9301,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9301 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate(request) {
        if (request.responseFormat === "json_object") {
          return {
            model: "gpt-5-mini",
            text: JSON.stringify({
              intent: "answer_question",
              objective: "Recommend Telugu songs from 2025",
              replyStyle: "structured",
              mentionLimits: false,
            }),
          };
        }

        return {
          model: "gpt-5-mini",
          text: [
            "1. Song One (2025) - A likely dance-heavy Telugu pick with strong theatre energy.",
            "2. Song Two (2025) - A romantic commercial track with broad repeat-listen appeal.",
            "3. Song Three (2025) - A darker mass number with punchy hooks and momentum.",
          ].join("\n"),
        };
      },
      async *stream() {
        throw new Error("stream should not be called for GPT-5 structured recommendations");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup() {
        return null;
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 14,
        message: {
          message_id: 104,
          text: "best telugu songs of 2025",
          date: 1_710_238_800,
          chat: {
            id: 700003,
          },
          from: {
            id: 334,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700003");
      assert.equal(messages.length, 2);
      assert.doesNotMatch(messages[1]?.text ?? "", /couldn't retrieve verified live data/i);
      assert.match(messages[1]?.text ?? "", /Song One/i);
      assert.doesNotMatch(messages[1]?.text ?? "", /2022|2023|2024/i);
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook uses recent conversation context for year-only follow-ups before falling back", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const liveLookupInputs: string[] = [];

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9302,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9302 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate(request) {
        if (request.responseFormat === "json_object") {
          return {
            model: "gpt-5-mini",
            text: JSON.stringify({
              intent: "answer_question",
              objective: "Recommend Telugu songs from 2025 only",
              replyStyle: "structured",
              mentionLimits: false,
            }),
          };
        }

        return {
          model: "gpt-5-mini",
          text: [
            "1. Verified Song One (2025) - A strong Telugu 2025 shortlist pick.",
            "2. Verified Song Two (2025) - Another likely 2025 song choice worth trying.",
          ].join("\n"),
        };
      },
      async *stream() {
        throw new Error("stream should not be called for GPT-5 structured recommendations");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup(input) {
        liveLookupInputs.push(input);

        if (liveLookupInputs.length === 1) {
          return {
            answer: "1. **Verified Song One (2025)**\n2. **Verified Song Two (2025)**",
            sources: [],
            rawText: "{\"answer\":\"verified\"}",
            model: "gpt-4o-mini-search-preview",
          };
        }

        return null;
      },
    },
  });

  try {
    await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 15,
        message: {
          message_id: 105,
          text: "best telugu songs of 2025",
          date: 1_710_238_800,
          chat: {
            id: 700004,
          },
          from: {
            id: 335,
          },
        },
      },
    });

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700004");
      assert.equal(messages.length, 2);
      assert.match(messages[1]?.text ?? "", /Verified Song One/i);
    });

    await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 16,
        message: {
          message_id: 106,
          text: "i want only from 2025",
          date: 1_710_238_810,
          chat: {
            id: 700004,
          },
          from: {
            id: 335,
          },
        },
      },
    });

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700004");
      assert.equal(messages.length, 4);
      assert.match(messages[3]?.text ?? "", /Verified Song One/i);
      assert.doesNotMatch(messages[3]?.text ?? "", /couldn't retrieve verified live data/i);
    });

    assert.equal(liveLookupInputs.length, 2);
    assert.match(liveLookupInputs[1] ?? "", /<recent_conversation>/);
    assert.match(liveLookupInputs[1] ?? "", /best telugu songs of 2025/i);
    assert.match(liveLookupInputs[1] ?? "", /i want only from 2025/i);
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook falls back cleanly for historical year recommendation requests when live lookup is unavailable", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9303,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9303 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate(request) {
        if (request.responseFormat === "json_object") {
          return {
            model: "gpt-5-mini",
            text: JSON.stringify({
              intent: "answer_question",
              objective: "Recommend English songs from 2021",
              replyStyle: "structured",
              mentionLimits: false,
            }),
          };
        }

        return {
          model: "gpt-5-mini",
          text: [
            "1. **Levitating** by Dua Lipa",
            "2. **Save Your Tears** by The Weeknd",
            "Source: [Wikipedia](https://example.com/list?utm_source=openai)",
          ].join("\n"),
        };
      },
      async *stream() {
        throw new Error("stream should not be called for GPT-5 structured recommendations");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup() {
        return null;
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 17,
        message: {
          message_id: 107,
          text: "best songs from 2021 english",
          date: 1_710_238_820,
          chat: {
            id: 700005,
          },
          from: {
            id: 336,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700005");
      assert.equal(messages.length, 2);
      assert.match(messages[1]?.text ?? "", /Levitating/i);
      assert.doesNotMatch(messages[1]?.text ?? "", /couldn't retrieve verified live data/i);
      assert.doesNotMatch(messages[1]?.text ?? "", /\*\*|\[Wikipedia\]|\]\(|utm_source=openai/i);
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook falls back cleanly for evergreen future-year place recommendations when live lookup is unavailable", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9308,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9308 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate(request) {
        if (request.responseFormat === "json_object") {
          return {
            model: "gpt-5-mini",
            text: JSON.stringify({
              intent: "answer_question",
              objective: "Recommend places to visit in Rajasthan in 2026",
              replyStyle: "structured",
              mentionLimits: false,
            }),
          };
        }

        return {
          model: "gpt-5-mini",
          text: [
            "1. Jaipur - Pink City landmarks, forts, bazaars, and an easy first-time Rajasthan base",
            "2. Udaipur - Lakeside palaces, sunset boat rides, and a calmer romantic atmosphere",
            "3. Jaisalmer - Golden fort views, desert camps, and classic Thar dune experiences",
          ].join("\n"),
        };
      },
      async *stream() {
        throw new Error("stream should not be called for GPT-5 structured recommendations");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup() {
        return null;
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 22,
        message: {
          message_id: 112,
          text: "best places to visit in rajasthan in 2026",
          date: 1_710_238_870,
          chat: {
            id: 700009,
          },
          from: {
            id: 340,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700009");
      assert.equal(messages.length, 2);
      assert.match(messages[1]?.text ?? "", /Jaipur/i);
      assert.match(messages[1]?.text ?? "", /Udaipur/i);
      assert.doesNotMatch(messages[1]?.text ?? "", /couldn't retrieve verified live data/i);
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook falls back cleanly for future-year course recommendations when live lookup is unavailable", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9309,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9309 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    liveLookupClient: {
      async lookup() {
        return null;
      },
    },
    llmClient: {
      async generate(request) {
        if (request.responseFormat === "json_object") {
          return {
            model: "gpt-5-mini",
            text: JSON.stringify({
              intent: "answer_question",
              objective: "Recommend AI courses to learn in 2026",
              replyStyle: "structured",
              mentionLimits: false,
            }),
          };
        }

        return {
          model: "gpt-5-mini",
          text: [
            "1. Deep Learning Specialization - Strong deep-learning fundamentals with practical TensorFlow assignments",
            "2. CS229 - Stanford machine-learning theory with rigorous core concepts",
            "3. Practical Deep Learning for Coders - Fast-paced applied course focused on building real models",
          ].join("\n"),
        };
      },
      async *stream() {
        throw new Error("stream should not be called for GPT-5 structured recommendations");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 39,
        message: {
          message_id: 309,
          text: "best ai courses to learn in 2026",
          date: 1_710_238_871,
          chat: {
            id: 700010,
          },
          from: {
            id: 341,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700010");
      assert.equal(messages.length, 2);
      assert.doesNotMatch(messages[1]?.text ?? "", /couldn't retrieve verified live data/i);
      assert.match(messages[1]?.text ?? "", /Deep Learning Specialization/i);
      assert.match(messages[1]?.text ?? "", /CS229/i);
    });
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook retries the last real user request when the user says try again", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const liveLookupInputs: string[] = [];

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9304,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9304 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate(request) {
        if (request.responseFormat === "json_object") {
          return {
            model: "gpt-5-mini",
            text: JSON.stringify({
              intent: "answer_question",
              objective: "Recommend English songs from 2021",
              replyStyle: "structured",
              mentionLimits: false,
            }),
          };
        }

        return {
          model: "gpt-5-mini",
          text: "1. Levitating by Dua Lipa\n2. Save Your Tears by The Weeknd",
        };
      },
      async *stream() {
        throw new Error("stream should not be called for GPT-5 structured recommendations");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
    liveLookupClient: {
      async lookup(input) {
        liveLookupInputs.push(input);

        if (liveLookupInputs.length === 1) {
          return null;
        }

        return {
          answer: '1. **Levitating** by Dua Lipa\n2. **Save Your Tears** by The Weeknd\nSource: [Billboard](https://example.com/billboard?utm_source=openai)',
          sources: [],
          rawText: "{\"answer\":\"retry-result\"}",
          model: "gpt-4o-mini-search-preview",
        };
      },
    },
  });

  try {
    await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 18,
        message: {
          message_id: 108,
          text: "best songs from 2021 english",
          date: 1_710_238_830,
          chat: {
            id: 700006,
          },
          from: {
            id: 337,
          },
        },
      },
    });

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700006");
      assert.equal(messages.length, 2);
      assert.match(messages[1]?.text ?? "", /Levitating/i);
    });

    await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 19,
        message: {
          message_id: 109,
          text: "try again",
          date: 1_710_238_840,
          chat: {
            id: 700006,
          },
          from: {
            id: 337,
          },
        },
      },
    });

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("700006");
      assert.equal(messages.length, 4);
      assert.match(messages[3]?.text ?? "", /Levitating/i);
      assert.doesNotMatch(messages[3]?.text ?? "", /\*\*|\[Billboard\]|\]\(|utm_source=openai/i);
    });

    assert.equal(liveLookupInputs.length, 3);
    assert.equal(liveLookupInputs[0], "best songs from 2021 english");
    assert.match(liveLookupInputs[1] ?? "", /Return a verified numbered list with at least 2 items if possible/i);
    assert.equal(liveLookupInputs[2], "best songs from 2021 english");
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook rejects a request with the wrong secret", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        throw new Error("sendMessage should not be called");
      },
      async editMessageText() {
        throw new Error("editMessageText should not be called");
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called");
      },
      async *stream() {
        throw new Error("stream should not be called");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "wrong-secret",
      },
      payload: {
        update_id: 2,
        message: {
          message_id: 88,
          text: "should fail",
          from: {
            id: 444,
          },
          chat: {
            id: 123456,
          },
        },
      },
    });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), {
      error: "Invalid Telegram webhook secret",
    });
    assert.equal(store.listMessagesByChat("123456").length, 0);
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("background llm failures mark messages failed and update the Telegram placeholder", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9004,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9004 } }),
        };
      },
      async editMessageText(input) {
        editedMessages.push(input);
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        throw new LlmRequestError("OpenAI generate failed", 502);
      },
      async *stream() {
        yield {
          type: "completed",
          text: "",
          model: "gpt-5-mini",
        };
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 3,
        message: {
          message_id: 99,
          text: "reply should fail",
          chat: {
            id: 123456,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      accepted: true,
    });

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("123456");
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.status, "failed");
      assert.equal(messages[1]?.status, "failed");
      assert.equal(
        messages[1]?.text,
        "Sorry, I hit an AI error while replying. Please try again.",
      );
    });

    assert.ok(
      editedMessages.some(
        (message) =>
          message.text === "Sorry, I hit an AI error while replying. Please try again.",
      ),
    );
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook still sends the final reply when the placeholder send fails", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const sentMessages: Array<{ chatId: string; text: string; replyToMessageId?: number }> = [];
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
  let sendAttemptCount = 0;

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage(input) {
        sendAttemptCount += 1;
        sentMessages.push(input);

        if (sendAttemptCount === 1) {
          throw new TelegramDeliveryError("Telegram sendMessage failed", 502);
        }

        return {
          delivered: true,
          messageId: 9007,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9007 } }),
        };
      },
      async editMessageText(input) {
        editedMessages.push(input);
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        return {
          model: "gpt-5-mini",
          text: JSON.stringify({
            intent: "answer_question",
            objective: "Answer the user directly",
            replyStyle: "concise",
            mentionLimits: false,
          }),
        };
      },
      async *stream() {
        yield {
          type: "text-delta",
          delta: "Final reply after placeholder failure",
        };
        yield {
          type: "completed",
          text: "Final reply after placeholder failure",
          model: "gpt-5-mini",
        };
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 33,
        message: {
          message_id: 133,
          text: "action",
          chat: {
            id: 123456,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("123456");
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.status, "processed");
      assert.equal(messages[1]?.status, "processed");
      assert.equal(messages[1]?.text, "Final reply after placeholder failure");
      assert.equal(messages[1]?.telegramMessageId, 9007);
    });

    assert.equal(sendAttemptCount, 2);
    assert.deepEqual(sentMessages, [
      {
        chatId: "123456",
        text: "Thinking...",
        replyToMessageId: 133,
      },
      {
        chatId: "123456",
        text: "Final reply after placeholder failure",
        replyToMessageId: 133,
      },
    ]);
    assert.equal(editedMessages.length, 0);
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook falls back to a fresh send when the final edit fails", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const sentMessages: Array<{ chatId: string; text: string; replyToMessageId?: number }> = [];
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
  let editAttemptCount = 0;

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage(input) {
        sentMessages.push(input);
        return {
          delivered: true,
          messageId: sentMessages.length === 1 ? 9008 : 9009,
          payloadJson: JSON.stringify({
            ok: true,
            result: { message_id: sentMessages.length === 1 ? 9008 : 9009 },
          }),
        };
      },
      async editMessageText(input) {
        editAttemptCount += 1;
        editedMessages.push(input);

        if (editAttemptCount === 1) {
          throw new TelegramDeliveryError("Telegram editMessageText failed", 502);
        }

        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        return {
          model: "gpt-5-mini",
          text: JSON.stringify({
            intent: "answer_question",
            objective: "Answer the user directly",
            replyStyle: "concise",
            mentionLimits: false,
          }),
        };
      },
      async *stream() {
        yield {
          type: "completed",
          text: "Clarified final reply",
          model: "gpt-5-mini",
        };
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 34,
        message: {
          message_id: 134,
          text: "released in year 2025",
          chat: {
            id: 123456,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("123456");
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.status, "processed");
      assert.equal(messages[1]?.status, "processed");
      assert.equal(messages[1]?.text, "Clarified final reply");
      assert.equal(messages[1]?.telegramMessageId, 9009);
    });

    assert.deepEqual(sentMessages, [
      {
        chatId: "123456",
        text: "Thinking...",
        replyToMessageId: 134,
      },
      {
        chatId: "123456",
        text: "Clarified final reply",
        replyToMessageId: 134,
      },
    ]);
    assert.equal(editedMessages.length, 1);
    assert.equal(editedMessages[0]?.text, "Clarified final reply");
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook uses completed stream text when no deltas arrive", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9005,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9005 } }),
        };
      },
      async editMessageText(input) {
        editedMessages.push(input);
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        return {
          model: "gpt-5-mini",
          text: JSON.stringify({
            intent: "answer_question",
            objective: "Answer the user directly",
            replyStyle: "concise",
            mentionLimits: false,
          }),
        };
      },
      async *stream() {
        yield {
          type: "completed",
          text: "Here is a helpful final answer",
          model: "gpt-5-mini",
        };
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 31,
        message: {
          message_id: 131,
          text: "hello bot",
          chat: {
            id: 123456,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("123456");
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.status, "processed");
      assert.equal(messages[1]?.status, "processed");
      assert.equal(messages[1]?.text, "Here is a helpful final answer");
    });

    assert.ok(
      editedMessages.some(
        (message) => message.text === "Here is a helpful final answer",
      ),
    );
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook recovers empty streams with a non-streamed response", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  let generateCallCount = 0;
  let streamCallCount = 0;

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9006,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9006 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        generateCallCount += 1;

        if (generateCallCount === 1) {
          return {
            model: "gpt-5-mini",
            text: JSON.stringify({
              intent: "answer_question",
              objective: "Recommend movies",
              replyStyle: "structured",
              mentionLimits: false,
            }),
          };
        }

        return {
          model: "gpt-5-mini",
          text: "Here are a few Telugu movies to try: 1. A major theatrical hit with strong word of mouth. 2. A family drama with great music. 3. A crime thriller if you want something darker.",
        };
      },
      async *stream() {
        streamCallCount += 1;
        yield {
          type: "completed",
          text: "",
          model: "gpt-5-mini",
        };
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 32,
        message: {
          message_id: 132,
          text: "suggest me best movies in telugu",
          chat: {
            id: 123456,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("123456");
      assert.equal(messages.length, 2);
      assert.equal(messages[1]?.status, "processed");
      assert.equal(
        messages[1]?.text,
        [
          "Shortlist of movies:",
          "",
          "1) A major theatrical hit with strong word of mouth",
          "2) A family drama with great music",
          "3) A crime thriller if you want something darker",
        ].join("\n"),
      );
    });

    assert.equal(generateCallCount, 2);
    assert.equal(streamCallCount, 0);
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("createTelegramClient times out slow Telegram requests", async () => {
  const client = createTelegramClient(
    "bot-token",
    20,
    async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("signal missing"));
          return;
        }

        signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        );
      }),
  );

  await assert.rejects(
    () =>
      client.sendMessage({
        chatId: "123456",
        text: "hello",
      }),
    (error: unknown) =>
      error instanceof TelegramDeliveryError &&
      error.statusCode === 504 &&
      error.message.includes("timed out"),
  );
});

test("telegram webhook sanitizes incoming text before planning", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const plannerRequests: LlmGenerateRequest[] = [];

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9010,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9010 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate(request) {
        plannerRequests.push(request);
        return {
          model: "gpt-5-mini",
          text: JSON.stringify({
            intent: "answer_question",
            objective: "Answer the user directly",
            replyStyle: "concise",
            mentionLimits: false,
          }),
        };
      },
      async *stream() {
        yield {
          type: "text-delta",
          delta: "hello\nbot",
        };
        yield {
          type: "completed",
          text: "hello\nbot",
          model: "gpt-5-mini",
        };
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 4,
        message: {
          message_id: 100,
          text: "he\u0000llo\r\nbot",
          chat: {
            id: 123456,
          },
          from: {
            id: 444,
          },
        },
      },
    });

    assert.equal(response.statusCode, 200);

    await waitForCondition(() => {
      const messages = store.listMessagesByChat("123456");
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.text, "hello\nbot");
      assert.equal(messages[1]?.text, "hello\nbot");
    });

    assert.match(plannerRequests[0]?.messages[1]?.content ?? "", /hello\nbot/);
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook rate limits repeated messages from the same chat", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const config = createTestConfig(temp.filePath);
  config.telegram.rateLimitWindowMs = 60000;
  config.telegram.rateLimitMaxRequests = 1;

  const app = buildApp(config, {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        return {
          delivered: true,
          messageId: 9003,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9003 } }),
        };
      },
      async editMessageText(input) {
        return {
          delivered: true,
          messageId: input.messageId,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: input.messageId } }),
        };
      },
    },
    llmClient: {
      async generate() {
        return {
          model: "gpt-5-mini",
          text: JSON.stringify({
            intent: "answer_question",
            objective: "Answer the user directly",
            replyStyle: "concise",
            mentionLimits: false,
          }),
        };
      },
      async *stream() {
        yield {
          type: "text-delta",
          delta: "first response",
        };
        yield {
          type: "completed",
          text: "first response",
          model: "gpt-5-mini",
        };
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const firstResponse = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 5,
        message: {
          message_id: 101,
          text: "first",
          chat: {
            id: 123456,
          },
        },
      },
    });

    const secondResponse = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 6,
        message: {
          message_id: 102,
          text: "second",
          chat: {
            id: 123456,
          },
        },
      },
    });

    assert.equal(firstResponse.statusCode, 200);
    assert.equal(secondResponse.statusCode, 429);
    assert.deepEqual(secondResponse.json(), {
      error: "Rate limit exceeded",
    });
    assert.ok(Number(secondResponse.headers["retry-after"]) >= 1);
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});

test("telegram webhook returns a persistence error when storing messages fails", async () => {
  const app = buildApp(createTestConfig(":memory:"), {
    messageStore: {
      insertMessage() {
        throw new Error("disk full");
      },
      updateMessage() {
        throw new Error("should not update");
      },
      listMessagesByChat() {
        return [];
      },
      insertToolAuditLog() {
        throw new Error("should not insert tool audit logs");
      },
      updateToolAuditLog() {
        throw new Error("should not update tool audit logs");
      },
      getPendingToolAuditLog() {
        return null;
      },
      listToolAuditLogs() {
        return [];
      },
      upsertScheduledTask() {
        throw new Error("should not upsert scheduled tasks");
      },
      getScheduledTaskByName() {
        return null;
      },
      updateScheduledTask() {
        throw new Error("should not update scheduled tasks");
      },
      listScheduledTasks() {
        return [];
      },
      listDueScheduledTasks() {
        return [];
      },
      markScheduledTaskRunning() {
        return null;
      },
      releaseStaleScheduledTasks() {
        return 0;
      },
      insertScheduledTaskRun() {
        throw new Error("should not insert scheduled task runs");
      },
      listScheduledTaskRuns() {
        return [];
      },
      close() {},
    },
    telegramClient: {
      async sendMessage() {
        throw new Error("sendMessage should not be called");
      },
      async editMessageText() {
        throw new Error("editMessageText should not be called");
      },
    },
    llmClient: {
      async generate() {
        throw new Error("generate should not be called");
      },
      async *stream() {
        throw new Error("stream should not be called");
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      payload: {
        update_id: 7,
        message: {
          message_id: 103,
          text: "hello",
          chat: {
            id: 123456,
          },
        },
      },
    });

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), {
      error: "Failed to persist message",
    });
  } finally {
    await app.close();
  }
});

test("log viewer routes expose recent task and audit history", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const config = createTestConfig(temp.filePath);
  const app = buildApp(config, {
    messageStore: store,
    llmClient: {
      async generate() {
        return {
          model: "gpt-5-mini",
          text: "ok",
        };
      },
      async *stream() {
        yield {
          type: "completed",
          text: "ok",
          model: "gpt-5-mini",
        };
      },
      async embeddings() {
        return {
          model: "text-embedding-3-small",
          vectors: [],
        };
      },
    },
  });

  try {
    const task = store.upsertScheduledTask({
      name: "heartbeat",
      schedule: "* * * * *",
      prompt: "Say hello",
      enabled: true,
      maxOutputTokens: 40,
      nextRunAt: "2026-03-28T10:05:00.000Z",
    });
    store.insertScheduledTaskRun({
      taskId: task.id,
      taskName: task.name,
      status: "completed",
      startedAt: "2026-03-28T10:05:00.000Z",
      finishedAt: "2026-03-28T10:05:02.000Z",
      durationMs: 2000,
      outputText: "scheduled task output",
      errorText: null,
    });
    store.insertToolAuditLog({
      chatId: "42",
      userId: "7",
      skillName: "shell_exec",
      status: "completed",
      userRequestText: "/shell_exec git status --short",
      commandText: "git status --short",
      outputText: "M README.md",
      errorText: null,
      durationMs: 15,
      resultSize: 11,
      requiresConfirmation: false,
    });

    const htmlResponse = await app.inject({
      method: "GET",
      url: "/logs",
    });
    assert.equal(htmlResponse.statusCode, 200);
    assert.match(htmlResponse.body, /Claw Dupe Task Logs/);
    assert.match(htmlResponse.body, /heartbeat/);
    assert.match(htmlResponse.body, /git status --short/);

    const jsonResponse = await app.inject({
      method: "GET",
      url: "/logs.json",
    });
    assert.equal(jsonResponse.statusCode, 200);
    const payload = jsonResponse.json() as {
      tasks: Array<{ name: string }>;
      taskRuns: Array<{ taskName: string }>;
      toolAudits: Array<{ commandText: string }>;
    };
    assert.equal(payload.tasks[0]?.name, "heartbeat");
    assert.equal(payload.taskRuns[0]?.taskName, "heartbeat");
    assert.equal(payload.toolAudits[0]?.commandText, "git status --short");
  } finally {
    await app.close();
    store.close();
    temp.cleanup();
  }
});
