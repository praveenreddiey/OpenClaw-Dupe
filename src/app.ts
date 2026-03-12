import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import {
  createMessageStore,
  type MessageRecord,
  type MessageStore,
  type MessageUpdate,
} from "./db.js";

type TelegramChat = {
  id: number | string;
};

type TelegramUser = {
  id: number | string;
};

type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  date?: number;
  text?: string;
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

export type TelegramSendInput = {
  chatId: string;
  text: string;
  replyToMessageId?: number;
};

export type TelegramSendResult = {
  delivered: boolean;
  messageId: number | null;
  payloadJson: string | null;
};

export type TelegramClient = {
  sendMessage(input: TelegramSendInput): Promise<TelegramSendResult>;
};

type BuildAppOptions = {
  messageStore?: MessageStore;
  telegramClient?: TelegramClient;
};

type TextTelegramMessage = TelegramMessage & {
  text: string;
};

export class TelegramDeliveryError extends Error {
  readonly statusCode: number;

  constructor(
    message: string,
    statusCode = 502,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TelegramDeliveryError";
    this.statusCode = statusCode;
  }
}

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

function getTextMessage(update: TelegramUpdate): TextTelegramMessage | null {
  const candidate = update.message ?? update.edited_message;
  if (!candidate?.text) {
    return null;
  }

  return {
    ...candidate,
    text: candidate.text,
  };
}

function parseTelegramErrorDescription(
  payloadText: string,
  statusText: string,
): string {
  try {
    const payload = JSON.parse(payloadText) as {
      description?: string;
    };

    return payload.description ?? statusText;
  } catch {
    return statusText;
  }
}

function sanitizeTelegramText(text: string): string {
  let normalized = text;
  try {
    normalized = text.normalize("NFKC");
  } catch {
    normalized = text;
  }

  return normalized
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

function sanitizeTelegramUpdateForStorage(update: TelegramUpdate): TelegramUpdate {
  const sanitizeMessage = (
    message: TelegramMessage | undefined,
  ): TelegramMessage | undefined => {
    if (!message) {
      return undefined;
    }

    return {
      ...message,
      text: typeof message.text === "string"
        ? sanitizeTelegramText(message.text)
        : message.text,
    };
  };

  return {
    ...update,
    message: sanitizeMessage(update.message),
    edited_message: sanitizeMessage(update.edited_message),
  };
}

function buildMessageTimestamp(unixSeconds?: number): string {
  if (typeof unixSeconds === "number" && Number.isFinite(unixSeconds) && unixSeconds > 0) {
    return new Date(unixSeconds * 1000).toISOString();
  }

  return new Date().toISOString();
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
    request.log.error({ err: error, messageId: id, ...context }, "failed to update message");
    return null;
  }
}

export function createTelegramClient(
  botToken: string,
  requestTimeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): TelegramClient {
  return {
    async sendMessage(input) {
      try {
        const response = await fetchImpl(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              chat_id: input.chatId,
              text: input.text,
              reply_to_message_id: input.replyToMessageId,
            }),
            signal: AbortSignal.timeout(requestTimeoutMs),
          },
        );

        const payloadText = await response.text();
        const payload = payloadText
          ? (JSON.parse(payloadText) as {
              ok?: boolean;
              result?: { message_id?: number };
              description?: string;
            })
          : {};

        if (!response.ok || !payload.ok) {
          throw new TelegramDeliveryError(
            `Telegram sendMessage failed: ${parseTelegramErrorDescription(payloadText, response.statusText)}`,
          );
        }

        return {
          delivered: true,
          messageId: payload.result?.message_id ?? null,
          payloadJson: payloadText || null,
        };
      } catch (error) {
        if (error instanceof TelegramDeliveryError) {
          throw error;
        }

        if (error instanceof Error && error.name === "TimeoutError") {
          throw new TelegramDeliveryError(
            `Telegram sendMessage timed out after ${requestTimeoutMs}ms`,
            504,
            { cause: error },
          );
        }

        throw new TelegramDeliveryError("Telegram sendMessage failed", 502, {
          cause: error,
        });
      }
    },
  };
}

export function buildApp(
  config: AppConfig,
  options: BuildAppOptions = {},
): FastifyInstance {
  const ownsStore = !options.messageStore;
  const messageStore =
    options.messageStore ?? createMessageStore(config.database.path);
  const telegramClient =
    options.telegramClient ??
    createTelegramClient(
      config.telegram.botToken,
      config.telegram.requestTimeoutMs,
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
    timestamp: new Date().toISOString(),
    telegramWebhookPath: config.telegram.webhookPath,
  }));

  app.post<{ Body: TelegramUpdate }>(
    config.telegram.webhookPath,
    async (request, reply) => {
      const configuredSecret = config.telegram.webhookSecret;
      const headerSecret = request.headers["x-telegram-bot-api-secret-token"];
      const providedSecret = Array.isArray(headerSecret)
        ? headerSecret[0]
        : headerSecret;

      if (configuredSecret && providedSecret !== configuredSecret) {
        request.log.warn("rejected telegram webhook with invalid secret");
        reply.status(401).send({ error: "Invalid Telegram webhook secret" });
        return;
      }

      const textMessage = getTextMessage(request.body);
      if (!textMessage) {
        request.log.info(
          { updateId: request.body?.update_id ?? null },
          "ignored telegram update without text",
        );
        reply.send({ ok: true, ignored: true });
        return;
      }

      const chatId = String(textMessage.chat.id);
      const userId = textMessage.from ? String(textMessage.from.id) : null;
      const incomingTimestamp = buildMessageTimestamp(textMessage.date);
      const sanitizedText = sanitizeTelegramText(textMessage.text);

      request.log.info(
        {
          updateId: request.body?.update_id ?? null,
          chatId,
          userId,
          telegramMessageId: textMessage.message_id,
          messageTimestamp: incomingTimestamp,
          status: "received",
          textLength: sanitizedText.length,
        },
        "received telegram message",
      );

      const rateLimit = rateLimiter.check(`chat:${chatId}`);
      if (!rateLimit.allowed) {
        request.log.warn(
          {
            updateId: request.body?.update_id ?? null,
            chatId,
            userId,
            retryAfterSeconds: rateLimit.retryAfterSeconds,
          },
          "rate limited telegram message",
        );
        reply.header("retry-after", String(rateLimit.retryAfterSeconds));
        reply.status(429).send({ error: "Rate limit exceeded" });
        return;
      }

      const incoming = insertMessageOrThrow(
        request,
        messageStore,
        {
          chatId,
          userId,
          direction: "incoming",
          status: "received",
          text: sanitizedText,
          telegramMessageId: textMessage.message_id,
          messageTimestamp: incomingTimestamp,
          payloadJson: JSON.stringify(sanitizeTelegramUpdateForStorage(request.body)),
        },
        {
          chatId,
          userId,
          direction: "incoming",
          telegramMessageId: textMessage.message_id,
        },
      );

      const replyText = `Echo: ${sanitizedText}`;
      let outgoing: MessageRecord;

      try {
        outgoing = insertMessageOrThrow(
          request,
          messageStore,
          {
            chatId,
            userId: null,
            direction: "outgoing",
            status: "received",
            text: replyText,
            messageTimestamp: buildMessageTimestamp(),
            payloadJson: null,
          },
          {
            chatId,
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
            chatId,
            userId,
            direction: "incoming",
            reason: "outgoing message placeholder insert failed",
          },
        );
        throw error;
      }

      try {
        const telegramResponse = await telegramClient.sendMessage({
          chatId,
          text: replyText,
          replyToMessageId: textMessage.message_id,
        });

        const responseTimestamp = buildMessageTimestamp();
        const processedIncoming = updateMessageSafely(
          request,
          messageStore,
          incoming.id,
          { status: "processed" },
          {
            chatId,
            userId,
            direction: "incoming",
          },
        );
        const processedOutgoing = updateMessageSafely(
          request,
          messageStore,
          outgoing.id,
          {
            status: "processed",
            telegramMessageId: telegramResponse.messageId,
            messageTimestamp: responseTimestamp,
            payloadJson: telegramResponse.payloadJson,
          },
          {
            chatId,
            direction: "outgoing",
          },
        );

        request.log.info(
          {
            updateId: request.body?.update_id ?? null,
            chatId,
            userId,
            incomingId: processedIncoming?.id ?? incoming.id,
            outgoingId: processedOutgoing?.id ?? outgoing.id,
            telegramMessageId: telegramResponse.messageId,
            delivered: telegramResponse.delivered,
            status: "processed",
            textLength: replyText.length,
          },
          "sent telegram response",
        );

        reply.send({
          ok: true,
          echoed: true,
          delivered: telegramResponse.delivered,
          replyText,
        });
      } catch (error) {
        updateMessageSafely(
          request,
          messageStore,
          incoming.id,
          { status: "failed" },
          {
            chatId,
            userId,
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
            messageTimestamp: buildMessageTimestamp(),
          },
          {
            chatId,
            direction: "outgoing",
          },
        );

        request.log.warn(
          {
            updateId: request.body?.update_id ?? null,
            chatId,
            userId,
            incomingId: incoming.id,
            outgoingId: outgoing.id,
            status: "failed",
            errorMessage: getErrorMessage(error),
          },
          "telegram response failed",
        );

        throw error;
      }
    },
  );

  return app;
}
