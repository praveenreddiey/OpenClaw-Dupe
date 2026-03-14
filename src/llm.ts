export type LlmProvider = "openai";

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type LlmGenerateRequest = {
  messages: LlmMessage[];
  maxOutputTokens: number;
  timeoutMs?: number;
  responseFormat?: "text" | "json_object";
};

export type LlmGenerateResult = {
  model: string;
  text: string;
  usage?: LlmUsage;
  rawJson?: string | null;
};

export type LlmStreamRequest = {
  messages: LlmMessage[];
  maxOutputTokens: number;
  timeoutMs?: number;
};

export type LlmStreamEvent =
  | {
      type: "text-delta";
      delta: string;
    }
  | {
      type: "completed";
      text: string;
      model: string;
      usage?: LlmUsage;
    };

export type LlmEmbeddingsRequest = {
  input: string | string[];
  model?: string;
  timeoutMs?: number;
};

export type LlmEmbeddingsResult = {
  model: string;
  vectors: number[][];
  rawJson?: string | null;
};

export type LlmClient = {
  generate(request: LlmGenerateRequest): Promise<LlmGenerateResult>;
  stream(request: LlmStreamRequest): AsyncIterable<LlmStreamEvent>;
  embeddings(request: LlmEmbeddingsRequest): Promise<LlmEmbeddingsResult>;
};

export class LlmRequestError extends Error {
  readonly statusCode: number;

  constructor(
    message: string,
    statusCode = 502,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LlmRequestError";
    this.statusCode = statusCode;
  }
}
