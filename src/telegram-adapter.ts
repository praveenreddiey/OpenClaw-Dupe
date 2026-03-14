import type {
  AdapterEditInput,
  AdapterSendInput,
  AdapterSendResult,
  MessageAdapter,
  UnifiedMessage,
} from "./messages.js";

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

type TextTelegramMessage = TelegramMessage & {
  text: string;
};

export type TelegramSendInput = {
  chatId: string;
  text: string;
  replyToMessageId?: number;
};

export type TelegramEditInput = {
  chatId: string;
  messageId: number;
  text: string;
};

export type TelegramSendResult = {
  delivered: boolean;
  messageId: number | null;
  payloadJson: string | null;
};

export type TelegramClient = {
  sendMessage(input: TelegramSendInput): Promise<TelegramSendResult>;
  editMessageText(input: TelegramEditInput): Promise<TelegramSendResult>;
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

function readOptionalInteger(value?: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function createTelegramClient(
  botToken: string,
  requestTimeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): TelegramClient {
  const callTelegramMethod = async (
    method: "sendMessage" | "editMessageText",
    body: Record<string, unknown>,
  ): Promise<TelegramSendResult> => {
    try {
      const response = await fetchImpl(
        `https://api.telegram.org/bot${botToken}/${method}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(requestTimeoutMs),
        },
      );

      const payloadText = await response.text();
      const payload = payloadText
        ? (JSON.parse(payloadText) as {
            ok?: boolean;
            result?: { message_id?: number };
          })
        : {};

      if (!response.ok || !payload.ok) {
        throw new TelegramDeliveryError(
          `Telegram ${method} failed: ${parseTelegramErrorDescription(payloadText, response.statusText)}`,
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
          `Telegram ${method} timed out after ${requestTimeoutMs}ms`,
          504,
          { cause: error },
        );
      }

      throw new TelegramDeliveryError(`Telegram ${method} failed`, 502, {
        cause: error,
      });
    }
  };

  return {
    async sendMessage(input) {
      return callTelegramMethod("sendMessage", {
        chat_id: input.chatId,
        text: input.text,
        reply_to_message_id: input.replyToMessageId,
      });
    },

    async editMessageText(input) {
      return callTelegramMethod("editMessageText", {
        chat_id: input.chatId,
        message_id: input.messageId,
        text: input.text,
      });
    },
  };
}

export class TelegramAdapter implements MessageAdapter {
  readonly name = "telegram";

  constructor(private readonly telegramClient: TelegramClient) {}

  verifyRequest(
    headers: Record<string, string | string[] | undefined>,
    configuredSecret: string,
  ): boolean {
    if (!configuredSecret) {
      return true;
    }

    const headerSecret = headers["x-telegram-bot-api-secret-token"];
    const providedSecret = Array.isArray(headerSecret)
      ? headerSecret[0]
      : headerSecret;
    return providedSecret === configuredSecret;
  }

  parseIncoming(body: unknown): UnifiedMessage | null {
    const update = body as TelegramUpdate;
    const textMessage = getTextMessage(update);
    if (!textMessage) {
      return null;
    }

    const chatId = String(textMessage.chat.id);
    const messageId = String(textMessage.message_id);

    return {
      platform: this.name,
      eventId: update.update_id != null ? String(update.update_id) : null,
      chatId,
      userId: textMessage.from ? String(textMessage.from.id) : null,
      messageId,
      replyToMessageId: messageId,
      text: sanitizeTelegramText(textMessage.text),
      timestamp: buildMessageTimestamp(textMessage.date),
      payloadJson: JSON.stringify(sanitizeTelegramUpdateForStorage(update)),
      rateLimitKey: `${this.name}:${chatId}`,
    };
  }

  async sendMessage(input: AdapterSendInput): Promise<AdapterSendResult> {
    const result = await this.telegramClient.sendMessage({
      chatId: input.chatId,
      text: input.text,
      replyToMessageId: readOptionalInteger(input.replyToMessageId),
    });

    return {
      delivered: result.delivered,
      messageId: result.messageId !== null ? String(result.messageId) : null,
      payloadJson: result.payloadJson,
      timestamp: buildMessageTimestamp(),
    };
  }

  async editMessage(input: AdapterEditInput): Promise<AdapterSendResult> {
    const result = await this.telegramClient.editMessageText({
      chatId: input.chatId,
      messageId: Number(input.messageId),
      text: input.text,
    });

    return {
      delivered: result.delivered,
      messageId: result.messageId !== null ? String(result.messageId) : input.messageId,
      payloadJson: result.payloadJson,
      timestamp: buildMessageTimestamp(),
    };
  }
}
