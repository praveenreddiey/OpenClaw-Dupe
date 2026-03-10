import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { createMessageStore, type MessageStore } from "./db.js";

type TelegramChat = {
  id: number | string;
};

type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
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

  const app = Fastify({
    logger: {
      level: config.logger.level,
    },
  });

  app.setErrorHandler((error, request, reply) => {
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

      if (configuredSecret && headerSecret !== configuredSecret) {
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
      const incoming = messageStore.insertMessage({
        chatId,
        direction: "incoming",
        text: textMessage.text,
        telegramMessageId: textMessage.message_id,
        payloadJson: JSON.stringify(request.body),
      });

      const replyText = `Echo: ${textMessage.text}`;
      const telegramResponse = await telegramClient.sendMessage({
        chatId,
        text: replyText,
        replyToMessageId: textMessage.message_id,
      });

      const outgoing = messageStore.insertMessage({
        chatId,
        direction: "outgoing",
        text: replyText,
        telegramMessageId: telegramResponse.messageId,
        payloadJson: telegramResponse.payloadJson,
      });

      request.log.info(
        {
          updateId: request.body?.update_id ?? null,
          chatId,
          incomingId: incoming.id,
          outgoingId: outgoing.id,
          delivered: telegramResponse.delivered,
        },
        "processed telegram echo",
      );

      reply.send({
        ok: true,
        echoed: true,
        delivered: telegramResponse.delivered,
        replyText,
      });
    },
  );

  return app;
}
