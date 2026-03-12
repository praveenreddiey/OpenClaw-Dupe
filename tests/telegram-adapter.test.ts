import test from "node:test";
import assert from "node:assert/strict";
import {
  TelegramAdapter,
  type TelegramClient,
} from "../src/telegram-adapter.js";

test("TelegramAdapter parses updates into a UnifiedMessage", () => {
  const adapter = new TelegramAdapter({
    async sendMessage() {
      throw new Error("sendMessage should not be called");
    },
  });

  const message = adapter.parseIncoming({
    update_id: 12,
    message: {
      message_id: 77,
      text: "he\u0000llo\r\nbot",
      date: 1_710_238_800,
      chat: {
        id: 123456,
      },
      from: {
        id: 444,
      },
    },
  });

  assert.ok(message);
  assert.equal(message?.platform, "telegram");
  assert.equal(message?.eventId, "12");
  assert.equal(message?.chatId, "123456");
  assert.equal(message?.userId, "444");
  assert.equal(message?.messageId, "77");
  assert.equal(message?.replyToMessageId, "77");
  assert.equal(message?.text, "hello\nbot");
  assert.equal(message?.timestamp, "2024-03-12T10:20:00.000Z");
  assert.equal(message?.rateLimitKey, "telegram:123456");
  assert.match(message?.payloadJson ?? "", /hello\\nbot/);
});

test("TelegramAdapter verifies secrets and sends replies through the Telegram client", async () => {
  let sentMessage:
    | { chatId: string; text: string; replyToMessageId?: number }
    | undefined;

  const client: TelegramClient = {
    async sendMessage(input) {
      sentMessage = input;
      return {
        delivered: true,
        messageId: 9001,
        payloadJson: JSON.stringify({ ok: true, result: { message_id: 9001 } }),
      };
    },
  };

  const adapter = new TelegramAdapter(client);

  assert.equal(
    adapter.verifyRequest(
      {
        "x-telegram-bot-api-secret-token": "secret-token",
      },
      "secret-token",
    ),
    true,
  );
  assert.equal(
    adapter.verifyRequest(
      {
        "x-telegram-bot-api-secret-token": "wrong-secret",
      },
      "secret-token",
    ),
    false,
  );

  const result = await adapter.sendMessage({
    chatId: "123456",
    text: "Echo: hello",
    replyToMessageId: "77",
  });

  assert.deepEqual(sentMessage, {
    chatId: "123456",
    text: "Echo: hello",
    replyToMessageId: 77,
  });
  assert.equal(result.delivered, true);
  assert.equal(result.messageId, "9001");
  assert.match(result.payloadJson ?? "", /9001/);
});
