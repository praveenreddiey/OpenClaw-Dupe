import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMessageStore } from "../src/db.js";
import { encodeStaticReminderPrompt } from "../src/reminders.js";
import { createTaskScheduler } from "../src/scheduler.js";
import type { LlmClient } from "../src/llm.js";
import type { MessageAdapter } from "../src/messages.js";

function createTempDatabasePath(): { filePath: string; cleanup: () => void } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "claw-dupe-scheduler-"));
  return {
    filePath: path.join(directory, "scheduler.db"),
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
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for condition");
}

function createNoopLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    child() {
      return this;
    },
  } as never;
}

test("createTaskScheduler executes due tasks and stores their run history", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const llmClient: LlmClient = {
    async generate() {
      return {
        model: "gpt-5-mini",
        text: "scheduled task output",
      };
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
  };

  store.upsertScheduledTask({
    name: "heartbeat",
    schedule: "* * * * *",
    prompt: "Say hello",
    enabled: true,
    maxOutputTokens: 40,
    nextRunAt: new Date(Date.now() - 1_000).toISOString(),
  });

  const scheduler = createTaskScheduler({
    config: {
      enabled: true,
      pollIntervalMs: 20,
      runTimeoutMs: 500,
      rateLimitWindowMs: 60000,
      rateLimitMaxRuns: 5,
      tasks: [],
    },
    llmMaxResponseTokens: 80,
    logger: createNoopLogger(),
    llmClient,
    messageAdapter: {
      name: "scheduler-test",
      verifyRequest() {
        return true;
      },
      parseIncoming() {
        return null;
      },
      async sendMessage() {
        throw new Error("sendMessage should not be called without telegramChatId");
      },
      async editMessage() {
        throw new Error("editMessage should not be called in scheduler tests");
      },
    },
    messageStore: store,
  });

  try {
    scheduler.start();

    await waitForCondition(() => {
      const runs = store.listScheduledTaskRuns(5);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.status, "completed");
      assert.equal(runs[0]?.outputText, "scheduled task output");
    });

    const task = store.getScheduledTaskByName("heartbeat");
    assert.ok(task);
    assert.equal(task?.isRunning, false);
    assert.equal(task?.lastError, null);
    assert.equal(task?.lastOutputPreview, "scheduled task output");
  } finally {
    await scheduler.stop();
    store.close();
    temp.cleanup();
  }
});

test("createTaskScheduler sends scheduled output to Telegram when telegramChatId is configured", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const sentMessages: Array<{ chatId: string; text: string }> = [];

  const llmClient: LlmClient = {
    async generate() {
      return {
        model: "gpt-5-mini",
        text: "scheduled telegram output",
      };
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
  };

  const messageAdapter: MessageAdapter = {
    name: "scheduler-test",
    verifyRequest() {
      return true;
    },
    parseIncoming() {
      return null;
    },
    async sendMessage(input) {
      sentMessages.push({ chatId: input.chatId, text: input.text });
      return {
        delivered: true,
        messageId: "501",
        payloadJson: "{\"ok\":true}",
        timestamp: "2026-03-28T10:06:00.000Z",
      };
    },
    async editMessage() {
      throw new Error("editMessage should not be called in scheduler tests");
    },
  };

  store.upsertScheduledTask({
    name: "heartbeat",
    schedule: "* * * * *",
    prompt: "Say hello",
    enabled: true,
    maxOutputTokens: 40,
    telegramChatId: "chat-42",
    nextRunAt: new Date(Date.now() - 1_000).toISOString(),
  });

  const scheduler = createTaskScheduler({
    config: {
      enabled: true,
      pollIntervalMs: 20,
      runTimeoutMs: 500,
      rateLimitWindowMs: 60000,
      rateLimitMaxRuns: 5,
      tasks: [],
    },
    llmMaxResponseTokens: 80,
    logger: createNoopLogger(),
    llmClient,
    messageAdapter,
    messageStore: store,
  });

  try {
    scheduler.start();

    await waitForCondition(() => {
      const runs = store.listScheduledTaskRuns(5);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.status, "completed");
      assert.equal(sentMessages.length, 1);
    });

    assert.deepEqual(sentMessages[0], {
      chatId: "chat-42",
      text: "scheduled telegram output",
    });

    const outgoingMessages = store.listMessagesByChat("chat-42");
    assert.equal(outgoingMessages.length, 1);
    assert.equal(outgoingMessages[0]?.direction, "outgoing");
    assert.equal(outgoingMessages[0]?.status, "processed");
    assert.equal(outgoingMessages[0]?.text, "scheduled telegram output");
    assert.equal(outgoingMessages[0]?.telegramMessageId, 501);

    const task = store.getScheduledTaskByName("heartbeat");
    assert.equal(task?.telegramChatId, "chat-42");
  } finally {
    await scheduler.stop();
    store.close();
    temp.cleanup();
  }
});

test("createTaskScheduler marks the run failed when Telegram delivery fails", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const llmClient: LlmClient = {
    async generate() {
      return {
        model: "gpt-5-mini",
        text: "scheduled telegram output",
      };
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
  };

  const messageAdapter: MessageAdapter = {
    name: "scheduler-test",
    verifyRequest() {
      return true;
    },
    parseIncoming() {
      return null;
    },
    async sendMessage() {
      throw new Error("telegram unavailable");
    },
    async editMessage() {
      throw new Error("editMessage should not be called in scheduler tests");
    },
  };

  store.upsertScheduledTask({
    name: "heartbeat",
    schedule: "* * * * *",
    prompt: "Say hello",
    enabled: true,
    maxOutputTokens: 40,
    telegramChatId: "chat-42",
    nextRunAt: new Date(Date.now() - 1_000).toISOString(),
  });

  const scheduler = createTaskScheduler({
    config: {
      enabled: true,
      pollIntervalMs: 20,
      runTimeoutMs: 500,
      rateLimitWindowMs: 60000,
      rateLimitMaxRuns: 5,
      tasks: [],
    },
    llmMaxResponseTokens: 80,
    logger: createNoopLogger(),
    llmClient,
    messageAdapter,
    messageStore: store,
  });

  try {
    scheduler.start();

    await waitForCondition(() => {
      const runs = store.listScheduledTaskRuns(5);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.status, "failed");
    });

    const runs = store.listScheduledTaskRuns(5);
    assert.equal(runs[0]?.outputText, "scheduled telegram output");
    assert.match(runs[0]?.errorText ?? "", /telegram unavailable/);

    const task = store.getScheduledTaskByName("heartbeat");
    assert.equal(task?.lastOutputPreview, "scheduled telegram output");
    assert.match(task?.lastError ?? "", /telegram unavailable/);
    assert.equal(store.listMessagesByChat("chat-42").length, 0);
  } finally {
    await scheduler.stop();
    store.close();
    temp.cleanup();
  }
});

test("createTaskScheduler replaces empty model output with a readable fallback message", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const sentMessages: Array<{ chatId: string; text: string }> = [];

  const llmClient: LlmClient = {
    async generate() {
      return {
        model: "gpt-5-mini",
        text: "   ",
      };
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
  };

  const messageAdapter: MessageAdapter = {
    name: "scheduler-test",
    verifyRequest() {
      return true;
    },
    parseIncoming() {
      return null;
    },
    async sendMessage(input) {
      sentMessages.push({ chatId: input.chatId, text: input.text });
      return {
        delivered: true,
        messageId: "502",
        payloadJson: "{\"ok\":true}",
        timestamp: "2026-03-28T10:08:00.000Z",
      };
    },
    async editMessage() {
      throw new Error("editMessage should not be called in scheduler tests");
    },
  };

  store.upsertScheduledTask({
    name: "two-minute-reminder",
    schedule: "* * * * *",
    prompt: "Send one short check-in message saying the scheduler is working.",
    enabled: true,
    maxOutputTokens: 40,
    telegramChatId: "chat-42",
    nextRunAt: new Date(Date.now() - 1_000).toISOString(),
  });

  const scheduler = createTaskScheduler({
    config: {
      enabled: true,
      pollIntervalMs: 20,
      runTimeoutMs: 500,
      rateLimitWindowMs: 60000,
      rateLimitMaxRuns: 5,
      tasks: [],
    },
    llmMaxResponseTokens: 80,
    logger: createNoopLogger(),
    llmClient,
    messageAdapter,
    messageStore: store,
  });

  try {
    scheduler.start();

    await waitForCondition(() => {
      const runs = store.listScheduledTaskRuns(5);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.status, "completed");
      assert.equal(sentMessages.length, 1);
    });

    assert.deepEqual(sentMessages[0], {
      chatId: "chat-42",
      text: "Scheduled task two-minute-reminder completed successfully.",
    });

    const runs = store.listScheduledTaskRuns(5);
    assert.equal(
      runs[0]?.outputText,
      "Scheduled task two-minute-reminder completed successfully.",
    );
  } finally {
    await scheduler.stop();
    store.close();
    temp.cleanup();
  }
});

test("createTaskScheduler sends encoded reminder prompts without calling the llm", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const sentMessages: Array<{ chatId: string; text: string }> = [];
  let generateCallCount = 0;

  const llmClient: LlmClient = {
    async generate() {
      generateCallCount += 1;
      return {
        model: "gpt-5-mini",
        text: "should not be used",
      };
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
  };

  const messageAdapter: MessageAdapter = {
    name: "scheduler-test",
    verifyRequest() {
      return true;
    },
    parseIncoming() {
      return null;
    },
    async sendMessage(input) {
      sentMessages.push({ chatId: input.chatId, text: input.text });
      return {
        delivered: true,
        messageId: "503",
        payloadJson: "{\"ok\":true}",
        timestamp: "2026-03-28T10:10:00.000Z",
      };
    },
    async editMessage() {
      throw new Error("editMessage should not be called in scheduler tests");
    },
  };

  store.upsertScheduledTask({
    name: "reminder-chat-42-drink-water",
    schedule: "* * * * *",
    prompt: encodeStaticReminderPrompt("drink water"),
    enabled: true,
    maxOutputTokens: 1,
    telegramChatId: "chat-42",
    nextRunAt: new Date(Date.now() - 1_000).toISOString(),
  });

  const scheduler = createTaskScheduler({
    config: {
      enabled: true,
      pollIntervalMs: 20,
      runTimeoutMs: 500,
      rateLimitWindowMs: 60000,
      rateLimitMaxRuns: 5,
      tasks: [],
    },
    llmMaxResponseTokens: 80,
    logger: createNoopLogger(),
    llmClient,
    messageAdapter,
    messageStore: store,
  });

  try {
    scheduler.start();

    await waitForCondition(() => {
      const runs = store.listScheduledTaskRuns(5);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.status, "completed");
      assert.equal(sentMessages.length, 1);
    });

    assert.equal(generateCallCount, 0);
    assert.deepEqual(sentMessages[0], {
      chatId: "chat-42",
      text: "Reminder: drink water",
    });
  } finally {
    await scheduler.stop();
    store.close();
    temp.cleanup();
  }
});

test("createTaskScheduler disables a one-time reminder after successful delivery", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const llmClient: LlmClient = {
    async generate() {
      return {
        model: "gpt-5-mini",
        text: "should not be used",
      };
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
  };

  const messageAdapter: MessageAdapter = {
    name: "scheduler-test",
    verifyRequest() {
      return true;
    },
    parseIncoming() {
      return null;
    },
    async sendMessage() {
      return {
        delivered: true,
        messageId: "504",
        payloadJson: "{\"ok\":true}",
        timestamp: "2026-03-28T10:12:00.000Z",
      };
    },
    async editMessage() {
      throw new Error("editMessage should not be called in scheduler tests");
    },
  };

  store.upsertScheduledTask({
    name: "reminder-once-chat-42-send-email",
    schedule: "* * * * *",
    prompt: encodeStaticReminderPrompt("send email"),
    enabled: true,
    maxOutputTokens: 1,
    telegramChatId: "chat-42",
    runOnce: true,
    nextRunAt: new Date(Date.now() - 1_000).toISOString(),
  });

  const scheduler = createTaskScheduler({
    config: {
      enabled: true,
      pollIntervalMs: 20,
      runTimeoutMs: 500,
      rateLimitWindowMs: 60000,
      rateLimitMaxRuns: 5,
      tasks: [],
    },
    llmMaxResponseTokens: 80,
    logger: createNoopLogger(),
    llmClient,
    messageAdapter,
    messageStore: store,
  });

  try {
    scheduler.start();

    await waitForCondition(() => {
      const runs = store.listScheduledTaskRuns(5);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.status, "completed");
    });

    const task = store.getScheduledTaskByName("reminder-once-chat-42-send-email");
    assert.equal(task?.runOnce, true);
    assert.equal(task?.enabled, false);
    assert.equal(task?.nextRunAt, null);
  } finally {
    await scheduler.stop();
    store.close();
    temp.cleanup();
  }
});
