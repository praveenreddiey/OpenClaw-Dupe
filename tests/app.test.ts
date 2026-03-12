import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildApp,
  createTelegramClient,
  TelegramDeliveryError,
  type TelegramClient,
} from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { createMessageStore } from "../src/db.js";

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
    telegram: {
      botToken: "",
      webhookPath: "/telegram/webhook",
      webhookSecret: "secret-token",
      requestTimeoutMs: 5000,
      rateLimitWindowMs: 60000,
      rateLimitMaxRequests: 10,
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

test("telegram webhook echoes text and stores both directions", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const sentMessages: Array<{ chatId: string; text: string; replyToMessageId?: number }> = [];

  const telegramClient: TelegramClient = {
    async sendMessage(input) {
      sentMessages.push(input);
      return {
        delivered: true,
        messageId: 9001,
        payloadJson: JSON.stringify({ ok: true, result: { message_id: 9001 } }),
      };
    },
  };

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient,
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
      echoed: true,
      delivered: true,
      replyText: "Echo: hello bot",
    });

    assert.deepEqual(sentMessages, [
      {
        chatId: "123456",
        text: "Echo: hello bot",
        replyToMessageId: 77,
      },
    ]);

    const messages = store.listMessagesByChat("123456");
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.userId, "444");
    assert.equal(messages[0]?.direction, "incoming");
    assert.equal(messages[0]?.status, "processed");
    assert.equal(messages[0]?.text, "hello bot");
    assert.equal(messages[0]?.telegramMessageId, 77);
    assert.equal(messages[0]?.messageTimestamp, "2024-03-12T10:20:00.000Z");
    assert.equal(messages[1]?.userId, null);
    assert.equal(messages[1]?.direction, "outgoing");
    assert.equal(messages[1]?.status, "processed");
    assert.equal(messages[1]?.text, "Echo: hello bot");
    assert.equal(messages[1]?.telegramMessageId, 9001);
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

test("telegram webhook returns a delivery-specific error when reply sending fails", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient: {
      async sendMessage() {
        throw new TelegramDeliveryError("Telegram sendMessage failed", 502);
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
          from: {
            id: 444,
          },
          chat: {
            id: 123456,
          },
        },
      },
    });

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), {
      error: "Telegram sendMessage failed",
    });

    const messages = store.listMessagesByChat("123456");
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.direction, "incoming");
    assert.equal(messages[0]?.status, "failed");
    assert.equal(messages[0]?.text, "reply should fail");
    assert.equal(messages[1]?.direction, "outgoing");
    assert.equal(messages[1]?.status, "failed");
    assert.equal(messages[1]?.text, "Echo: reply should fail");
    assert.match(messages[1]?.payloadJson ?? "", /Telegram sendMessage failed/);
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

test("telegram webhook sanitizes incoming text before storing and replying", async () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);
  const telegramClient: TelegramClient = {
    async sendMessage(input) {
      return {
        delivered: true,
        messageId: 9002,
        payloadJson: JSON.stringify({ ok: true, result: { message_id: 9002 } }),
      };
    },
  };

  const app = buildApp(createTestConfig(temp.filePath), {
    messageStore: store,
    telegramClient,
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
    assert.deepEqual(response.json(), {
      ok: true,
      echoed: true,
      delivered: true,
      replyText: "Echo: hello\nbot",
    });

    const messages = store.listMessagesByChat("123456");
    assert.equal(messages[0]?.text, "hello\nbot");
    assert.match(messages[0]?.payloadJson ?? "", /hello\\nbot/);
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
      async sendMessage(input) {
        return {
          delivered: true,
          messageId: 9003,
          payloadJson: JSON.stringify({ ok: true, result: { message_id: 9003 } }),
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
    assert.equal(store.listMessagesByChat("123456").length, 2);
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
      close() {},
    },
    telegramClient: {
      async sendMessage() {
        throw new Error("sendMessage should not be called");
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
