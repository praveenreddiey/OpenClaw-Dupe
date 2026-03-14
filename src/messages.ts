export type UnifiedMessage = {
  platform: string;
  eventId: string | null;
  chatId: string;
  userId: string | null;
  messageId: string;
  replyToMessageId: string | null;
  text: string;
  timestamp: string;
  payloadJson: string;
  rateLimitKey: string;
};

export type AdapterSendInput = {
  chatId: string;
  text: string;
  replyToMessageId?: string | null;
};

export type AdapterEditInput = {
  chatId: string;
  messageId: string;
  text: string;
};

export type AdapterSendResult = {
  delivered: boolean;
  messageId: string | null;
  payloadJson: string | null;
  timestamp: string;
};

export type MessageAdapter = {
  readonly name: string;
  verifyRequest(
    headers: Record<string, string | string[] | undefined>,
    configuredSecret: string,
  ): boolean;
  parseIncoming(body: unknown): UnifiedMessage | null;
  sendMessage(input: AdapterSendInput): Promise<AdapterSendResult>;
  editMessage(input: AdapterEditInput): Promise<AdapterSendResult>;
};
