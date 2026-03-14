import {
  LlmRequestError,
  type LlmClient,
  type LlmEmbeddingsRequest,
  type LlmEmbeddingsResult,
  type LlmGenerateRequest,
  type LlmGenerateResult,
  type LlmMessage,
  type LlmStreamEvent,
  type LlmStreamRequest,
  type LlmUsage,
} from "./llm.js";

export type OpenAILlmConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  embeddingModel: string;
  requestTimeoutMs: number;
};

type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

function buildUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${pathname}`;
}

function mapUsage(usage?: OpenAIUsage): LlmUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

function readTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((part) => readTextContent(part)).join("");
  }

  if (content && typeof content === "object") {
    if ("text" in content && typeof content.text === "string") {
      return content.text;
    }

    if ("content" in content) {
      return readTextContent(content.content);
    }
  }

  return "";
}

function parseApiError(payloadText: string, fallback: string): string {
  try {
    const payload = JSON.parse(payloadText) as {
      error?: { message?: string };
    };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizeMessages(messages: LlmMessage[]): Array<{ role: string; content: string }> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function isGpt5Model(model: string): boolean {
  return /^gpt-5/i.test(model);
}

function extractChoiceText(choice: unknown): string {
  if (!choice || typeof choice !== "object") {
    return "";
  }

  if ("delta" in choice) {
    const deltaText = readTextContent(choice.delta);
    if (deltaText) {
      return deltaText;
    }
  }

  if ("message" in choice) {
    const messageText = readTextContent(choice.message);
    if (messageText) {
      return messageText;
    }
  }

  if ("text" in choice) {
    return readTextContent(choice.text);
  }

  return "";
}

function extractResponseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  if ("choices" in payload && Array.isArray(payload.choices)) {
    const choiceText = extractChoiceText(payload.choices[0]);
    if (choiceText) {
      return choiceText;
    }
  }

  if ("output_text" in payload) {
    return readTextContent(payload.output_text);
  }

  return "";
}

function mergeStreamText(
  accumulatedText: string,
  nextText: string,
): { accumulatedText: string; delta: string } {
  if (!nextText) {
    return {
      accumulatedText,
      delta: "",
    };
  }

  if (!accumulatedText) {
    return {
      accumulatedText: nextText,
      delta: nextText,
    };
  }

  if (nextText === accumulatedText || accumulatedText.endsWith(nextText)) {
    return {
      accumulatedText,
      delta: "",
    };
  }

  if (nextText.startsWith(accumulatedText)) {
    return {
      accumulatedText: nextText,
      delta: nextText.slice(accumulatedText.length),
    };
  }

  return {
    accumulatedText: `${accumulatedText}${nextText}`,
    delta: nextText,
  };
}

function buildChatRequestBody(
  config: OpenAILlmConfig,
  request: LlmGenerateRequest | LlmStreamRequest,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: normalizeMessages(request.messages),
    stream,
    max_completion_tokens: request.maxOutputTokens,
  };

  if (isGpt5Model(config.model)) {
    body.reasoning_effort = "low";
  }

  if ("responseFormat" in request && request.responseFormat === "json_object") {
    body.response_format = {
      type: "json_object",
    };
  }

  return body;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "TimeoutError" ||
    error.name === "AbortError"
  );
}

async function* iterateSseData(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex >= 0) {
        const eventBlock = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const eventData = eventBlock
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");

        if (eventData) {
          yield eventData;
        }

        separatorIndex = buffer.indexOf("\n\n");
      }
    }

    const trailingData = buffer.trim();
    if (trailingData) {
      const eventData = trailingData
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");

      if (eventData) {
        yield eventData;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function createOpenAILlmClient(
  config: OpenAILlmConfig,
  fetchImpl: typeof fetch = fetch,
): LlmClient {
  const createSignal = (timeoutMs?: number) =>
    AbortSignal.timeout(timeoutMs ?? config.requestTimeoutMs);

  return {
    async generate(request: LlmGenerateRequest): Promise<LlmGenerateResult> {
      try {
        const response = await fetchImpl(
          buildUrl(config.baseUrl, "/chat/completions"),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(buildChatRequestBody(config, request, false)),
            signal: createSignal(request.timeoutMs),
          },
        );

        const payloadText = await response.text();
        if (!response.ok) {
          throw new LlmRequestError(
            `OpenAI generate failed: ${parseApiError(payloadText, response.statusText)}`,
          );
        }

        const payload = JSON.parse(payloadText) as {
          model?: string;
          choices?: Array<{
            message?: { content?: unknown };
          }>;
          usage?: OpenAIUsage;
          output_text?: unknown;
        };

        return {
          model: payload.model ?? config.model,
          text: extractResponseText(payload),
          usage: mapUsage(payload.usage),
          rawJson: payloadText,
        };
      } catch (error) {
        if (error instanceof LlmRequestError) {
          throw error;
        }

        if (isTimeoutError(error)) {
          throw new LlmRequestError(
            `OpenAI generate timed out after ${request.timeoutMs ?? config.requestTimeoutMs}ms`,
            504,
            { cause: error },
          );
        }

        throw new LlmRequestError("OpenAI generate failed", 502, {
          cause: error,
        });
      }
    },

    async *stream(request: LlmStreamRequest): AsyncIterable<LlmStreamEvent> {
      let accumulatedText = "";

      try {
        const response = await fetchImpl(
          buildUrl(config.baseUrl, "/chat/completions"),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(buildChatRequestBody(config, request, true)),
            signal: createSignal(request.timeoutMs),
          },
        );

        if (!response.ok) {
          const payloadText = await response.text();
          throw new LlmRequestError(
            `OpenAI stream failed: ${parseApiError(payloadText, response.statusText)}`,
          );
        }

        if (!response.body) {
          throw new LlmRequestError("OpenAI stream failed: response body missing");
        }

        let streamedModel = config.model;

        for await (const eventData of iterateSseData(response.body)) {
          if (eventData === "[DONE]") {
            break;
          }

          const payload = JSON.parse(eventData) as {
            model?: string;
            usage?: OpenAIUsage;
            output_text?: unknown;
          };
          streamedModel = payload.model ?? streamedModel;
          const mergedText = mergeStreamText(
            accumulatedText,
            extractResponseText(payload),
          );
          accumulatedText = mergedText.accumulatedText;

          if (mergedText.delta) {
            yield {
              type: "text-delta",
              delta: mergedText.delta,
            };
          }
        }

        yield {
          type: "completed",
          text: accumulatedText,
          model: streamedModel,
        };
      } catch (error) {
        if (error instanceof LlmRequestError) {
          throw error;
        }

        if (isTimeoutError(error)) {
          throw new LlmRequestError(
            `OpenAI stream timed out after ${request.timeoutMs ?? config.requestTimeoutMs}ms`,
            504,
            { cause: error },
          );
        }

        throw new LlmRequestError("OpenAI stream failed", 502, {
          cause: error,
        });
      }
    },

    async embeddings(request: LlmEmbeddingsRequest): Promise<LlmEmbeddingsResult> {
      try {
        const response = await fetchImpl(
          buildUrl(config.baseUrl, "/embeddings"),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
              model: request.model ?? config.embeddingModel,
              input: request.input,
            }),
            signal: createSignal(request.timeoutMs),
          },
        );

        const payloadText = await response.text();
        if (!response.ok) {
          throw new LlmRequestError(
            `OpenAI embeddings failed: ${parseApiError(payloadText, response.statusText)}`,
          );
        }

        const payload = JSON.parse(payloadText) as {
          model?: string;
          data?: Array<{ embedding?: number[] }>;
        };

        return {
          model: payload.model ?? request.model ?? config.embeddingModel,
          vectors: (payload.data ?? []).map((entry) => entry.embedding ?? []),
          rawJson: payloadText,
        };
      } catch (error) {
        if (error instanceof LlmRequestError) {
          throw error;
        }

        if (isTimeoutError(error)) {
          throw new LlmRequestError(
            `OpenAI embeddings timed out after ${request.timeoutMs ?? config.requestTimeoutMs}ms`,
            504,
            { cause: error },
          );
        }

        throw new LlmRequestError("OpenAI embeddings failed", 502, {
          cause: error,
        });
      }
    },
  };
}
