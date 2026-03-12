import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import {
  createMessageStore,
  type MessageRecord,
  type MessageStore,
  type MessageUpdate,
} from "./db.js";
import type { MessageAdapter } from "./messages.js";
import {
  createTelegramClient,
  TelegramAdapter,
  TelegramDeliveryError,
  type TelegramClient,
} from "./telegram-adapter.js";

export {
  createTelegramClient,
  TelegramAdapter,
  TelegramDeliveryError,
  type TelegramClient,
};
export type { MessageAdapter } from "./messages.js";

type BuildAppOptions = {
  messageStore?: MessageStore;
  messageAdapter?: MessageAdapter;
  telegramClient?: TelegramClient;
};

class MessagePersistenceError extends Error {
  readonly statusCode: number;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MessagePersistenceError";
    this.statusCode = 500;
  }
}

type RateLimitCheckResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

type RateLimiter = {
  check(key: string): RateLimitCheckResult;
};

function createRateLimiter(windowMs: number, maxRequests: number): RateLimiter {
  const hitsByKey = new Map<string, number[]>();

  return {
    check(key) {
      const now = Date.now();
      const windowStart = now - windowMs;
      const activeHits = (hitsByKey.get(key) ?? []).filter(
        (timestamp) => timestamp > windowStart,
      );

      if (activeHits.length >= maxRequests) {
        hitsByKey.set(key, activeHits);
        const oldestHit = activeHits[0] ?? now;
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((windowMs - (now - oldestHit)) / 1000),
          ),
        };
      }

      activeHits.push(now);
      hitsByKey.set(key, activeHits);
      return {
        allowed: true,
        retryAfterSeconds: 0,
      };
    },
  };
}

function currentTimestamp(): string {
  return new Date().toISOString();
}

function parseStoredMessageId(messageId: string | null): number | null {
  if (!messageId) {
    return null;
  }

  const parsed = Number(messageId);
  return Number.isInteger(parsed) ? parsed : null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serializeErrorPayload(error: unknown): string {
  return JSON.stringify({
    name: error instanceof Error ? error.name : "Error",
    message: getErrorMessage(error),
  });
}

function insertMessageOrThrow(
  request: FastifyRequest,
  messageStore: MessageStore,
  message: Parameters<MessageStore["insertMessage"]>[0],
  context: Record<string, unknown>,
): MessageRecord {
  try {
    return messageStore.insertMessage(message);
  } catch (error) {
    request.log.error({ err: error, ...context }, "failed to persist message");
    throw new MessagePersistenceError("Failed to persist message", {
      cause: error,
    });
  }
}

function updateMessageSafely(
  request: FastifyRequest,
  messageStore: MessageStore,
  id: number,
  update: MessageUpdate,
  context: Record<string, unknown>,
): MessageRecord | null {
  try {
    return messageStore.updateMessage(id, update);
  } catch (error) {
    request.log.error(
      { err: error, messageId: id, ...context },
      "failed to update message",
    );
    return null;
  }
}

export function buildApp(
  config: AppConfig,
  options: BuildAppOptions = {},
): FastifyInstance {
  const ownsStore = !options.messageStore;
  const messageStore =
    options.messageStore ?? createMessageStore(config.database.path);
  const messageAdapter =
    options.messageAdapter ??
    new TelegramAdapter(
      options.telegramClient ??
        createTelegramClient(
          config.telegram.botToken,
          config.telegram.requestTimeoutMs,
        ),
    );
  const rateLimiter = createRateLimiter(
    config.telegram.rateLimitWindowMs,
    config.telegram.rateLimitMaxRequests,
  );

  const app = Fastify({
    logger: {
      level: config.logger.level,
    },
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof MessagePersistenceError) {
      request.log.error({ err: error }, "message persistence failed");
      reply.status(error.statusCode).send({ error: error.message });
      return;
    }

    if (error instanceof TelegramDeliveryError) {
      request.log.warn(
        { err: error, statusCode: error.statusCode },
        "telegram delivery failed",
      );
      reply.status(error.statusCode).send({ error: error.message });
      return;
    }

    request.log.error({ err: error }, "request failed");
    reply.status(500).send({ error: "Internal server error" });
  });

  app.addHook("onClose", async () => {
    if (ownsStore) {
      messageStore.close();
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    uptime: process.uptime(),
    timestamp: currentTimestamp(),
    telegramWebhookPath: config.telegram.webhookPath,
  }));

  app.post(
    config.telegram.webhookPath,
    async (request, reply) => {
      const headers = request.headers as Record<
        string,
        string | string[] | undefined
      >;
      if (!messageAdapter.verifyRequest(headers, config.telegram.webhookSecret)) {
        request.log.warn({ adapter: messageAdapter.name }, "rejected webhook with invalid secret");
        reply.status(401).send({ error: "Invalid Telegram webhook secret" });
        return;
      }

      const incomingMessage = messageAdapter.parseIncoming(request.body);
      if (!incomingMessage) {
        request.log.info(
          { adapter: messageAdapter.name },
          "ignored incoming update without a supported text payload",
        );
        reply.send({ ok: true, ignored: true });
        return;
      }

      request.log.info(
        {
          adapter: incomingMessage.platform,
          eventId: incomingMessage.eventId,
          chatId: incomingMessage.chatId,
          userId: incomingMessage.userId,
          externalMessageId: incomingMessage.messageId,
          messageTimestamp: incomingMessage.timestamp,
          status: "received",
          textLength: incomingMessage.text.length,
        },
        "received incoming message",
      );

      const rateLimit = rateLimiter.check(incomingMessage.rateLimitKey);
      if (!rateLimit.allowed) {
        request.log.warn(
          {
            adapter: incomingMessage.platform,
            eventId: incomingMessage.eventId,
            chatId: incomingMessage.chatId,
            userId: incomingMessage.userId,
            retryAfterSeconds: rateLimit.retryAfterSeconds,
          },
          "rate limited incoming message",
        );
        reply.header("retry-after", String(rateLimit.retryAfterSeconds));
        reply.status(429).send({ error: "Rate limit exceeded" });
        return;
      }

      const incoming = insertMessageOrThrow(
        request,
        messageStore,
        {
          chatId: incomingMessage.chatId,
          userId: incomingMessage.userId,
          direction: "incoming",
          status: "received",
          text: incomingMessage.text,
          telegramMessageId: parseStoredMessageId(incomingMessage.messageId),
          messageTimestamp: incomingMessage.timestamp,
          payloadJson: incomingMessage.payloadJson,
        },
        {
          adapter: incomingMessage.platform,
          chatId: incomingMessage.chatId,
          userId: incomingMessage.userId,
          direction: "incoming",
          externalMessageId: incomingMessage.messageId,
        },
      );

      const replyText = `Echo: ${incomingMessage.text}`;
      let outgoing: MessageRecord;

      try {
        outgoing = insertMessageOrThrow(
          request,
          messageStore,
          {
            chatId: incomingMessage.chatId,
            userId: null,
            direction: "outgoing",
            status: "received",
            text: replyText,
            messageTimestamp: currentTimestamp(),
            payloadJson: null,
          },
          {
            adapter: incomingMessage.platform,
            chatId: incomingMessage.chatId,
            direction: "outgoing",
            status: "received",
          },
        );
      } catch (error) {
        updateMessageSafely(
          request,
          messageStore,
          incoming.id,
          { status: "failed" },
          {
            adapter: incomingMessage.platform,
            chatId: incomingMessage.chatId,
            userId: incomingMessage.userId,
            direction: "incoming",
            reason: "outgoing message placeholder insert failed",
          },
        );
        throw error;
      }

      try {
        const delivery = await messageAdapter.sendMessage({
          chatId: incomingMessage.chatId,
          text: replyText,
          replyToMessageId: incomingMessage.replyToMessageId,
        });

        const processedIncoming = updateMessageSafely(
          request,
          messageStore,
          incoming.id,
          { status: "processed" },
          {
            adapter: incomingMessage.platform,
            chatId: incomingMessage.chatId,
            userId: incomingMessage.userId,
            direction: "incoming",
          },
        );
        const processedOutgoing = updateMessageSafely(
          request,
          messageStore,
          outgoing.id,
          {
            status: "processed",
            telegramMessageId: parseStoredMessageId(delivery.messageId),
            messageTimestamp: delivery.timestamp,
            payloadJson: delivery.payloadJson,
          },
          {
            adapter: incomingMessage.platform,
            chatId: incomingMessage.chatId,
            direction: "outgoing",
          },
        );

        request.log.info(
          {
            adapter: incomingMessage.platform,
            eventId: incomingMessage.eventId,
            chatId: incomingMessage.chatId,
            userId: incomingMessage.userId,
            incomingId: processedIncoming?.id ?? incoming.id,
            outgoingId: processedOutgoing?.id ?? outgoing.id,
            externalMessageId: delivery.messageId,
            delivered: delivery.delivered,
            status: "processed",
            textLength: replyText.length,
          },
          "sent outgoing response",
        );

        reply.send({
          ok: true,
          echoed: true,
          delivered: delivery.delivered,
          replyText,
        });
      } catch (error) {
        updateMessageSafely(
          request,
          messageStore,
          incoming.id,
          { status: "failed" },
          {
            adapter: incomingMessage.platform,
            chatId: incomingMessage.chatId,
            userId: incomingMessage.userId,
            direction: "incoming",
          },
        );
        updateMessageSafely(
          request,
          messageStore,
          outgoing.id,
          {
            status: "failed",
            payloadJson: serializeErrorPayload(error),
            messageTimestamp: currentTimestamp(),
          },
          {
            adapter: incomingMessage.platform,
            chatId: incomingMessage.chatId,
            direction: "outgoing",
          },
        );

        request.log.warn(
          {
            adapter: incomingMessage.platform,
            eventId: incomingMessage.eventId,
            chatId: incomingMessage.chatId,
            userId: incomingMessage.userId,
            incomingId: incoming.id,
            outgoingId: outgoing.id,
            status: "failed",
            errorMessage: getErrorMessage(error),
          },
          "outgoing response failed",
        );

        throw error;
      }
    },
  );

  return app;
}
