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
} from "./llm.js";

export type OllamaLlmConfig = {
  baseUrl: string;
  model: string;
  embeddingModel: string;
  requestTimeoutMs: number;
};

function buildUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${pathname}`;
}

function parseApiError(payloadText: string, fallback: string): string {
  try {
    const payload = JSON.parse(payloadText) as {
      error?: string;
    };
    return payload.error ?? fallback;
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

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "TimeoutError" ||
    error.name === "AbortError"
  );
}

function readOllamaText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  if ("message" in payload && payload.message && typeof payload.message === "object") {
    const content = "content" in payload.message ? payload.message.content : "";
    return typeof content === "string" ? content : "";
  }

  if ("response" in payload && typeof payload.response === "string") {
    return payload.response;
  }

  return "";
}

function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index] ?? "";

    if (escaping) {
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (character === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function normalizeJsonResponseText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }

  const candidates = [
    trimmed,
    trimmed.replace(/^```(?:json)?\s*|\s*```$/gi, ""),
    extractBalancedJsonObject(trimmed) ?? "",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return JSON.stringify(parsed);
      }
    } catch {
      // Keep trying the other candidates.
    }
  }

  return trimmed;
}

async function* iterateJsonLines(
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

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          yield line;
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }

    const trailingLine = buffer.trim();
    if (trailingLine) {
      yield trailingLine;
    }
  } finally {
    reader.releaseLock();
  }
}

export function createOllamaLlmClient(
  config: OllamaLlmConfig,
  fetchImpl: typeof fetch = fetch,
): LlmClient {
  const createSignal = (timeoutMs?: number) =>
    AbortSignal.timeout(timeoutMs ?? config.requestTimeoutMs);

  return {
    async generate(request: LlmGenerateRequest): Promise<LlmGenerateResult> {
      try {
        const response = await fetchImpl(
          buildUrl(config.baseUrl, "/api/chat"),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: config.model,
              stream: false,
              format: request.responseFormat === "json_object" ? "json" : undefined,
              options: {
                num_predict: request.maxOutputTokens,
              },
              messages: normalizeMessages(request.messages),
            }),
            signal: createSignal(request.timeoutMs),
          },
        );

        const payloadText = await response.text();
        if (!response.ok) {
          throw new LlmRequestError(
            `Ollama generate failed: ${parseApiError(payloadText, response.statusText)}`,
          );
        }

        const payload = JSON.parse(payloadText) as {
          model?: string;
        };
        const rawText = readOllamaText(payload);

        return {
          model: payload.model ?? config.model,
          text: request.responseFormat === "json_object"
            ? normalizeJsonResponseText(rawText)
            : rawText,
          rawJson: payloadText,
        };
      } catch (error) {
        if (error instanceof LlmRequestError) {
          throw error;
        }

        if (isTimeoutError(error)) {
          throw new LlmRequestError(
            `Ollama generate timed out after ${request.timeoutMs ?? config.requestTimeoutMs}ms`,
            504,
            { cause: error },
          );
        }

        throw new LlmRequestError("Ollama generate failed", 502, {
          cause: error,
        });
      }
    },

    async *stream(request: LlmStreamRequest): AsyncIterable<LlmStreamEvent> {
      let accumulatedText = "";

      try {
        const response = await fetchImpl(
          buildUrl(config.baseUrl, "/api/chat"),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: config.model,
              stream: true,
              options: {
                num_predict: request.maxOutputTokens,
              },
              messages: normalizeMessages(request.messages),
            }),
            signal: createSignal(request.timeoutMs),
          },
        );

        if (!response.ok) {
          const payloadText = await response.text();
          throw new LlmRequestError(
            `Ollama stream failed: ${parseApiError(payloadText, response.statusText)}`,
          );
        }

        if (!response.body) {
          throw new LlmRequestError("Ollama stream failed: response body missing");
        }

        let streamedModel = config.model;

        for await (const line of iterateJsonLines(response.body)) {
          const payload = JSON.parse(line) as {
            done?: boolean;
            model?: string;
          };
          streamedModel = payload.model ?? streamedModel;
          const delta = readOllamaText(payload);
          if (delta) {
            accumulatedText += delta;
            yield {
              type: "text-delta",
              delta,
            };
          }

          if (payload.done) {
            break;
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
            `Ollama stream timed out after ${request.timeoutMs ?? config.requestTimeoutMs}ms`,
            504,
            { cause: error },
          );
        }

        throw new LlmRequestError("Ollama stream failed", 502, {
          cause: error,
        });
      }
    },

    async embeddings(request: LlmEmbeddingsRequest): Promise<LlmEmbeddingsResult> {
      try {
        const response = await fetchImpl(
          buildUrl(config.baseUrl, "/api/embed"),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
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
            `Ollama embeddings failed: ${parseApiError(payloadText, response.statusText)}`,
          );
        }

        const payload = JSON.parse(payloadText) as {
          model?: string;
          embeddings?: number[][];
          embedding?: number[];
        };
        const vectors = payload.embeddings ?? (payload.embedding ? [payload.embedding] : []);

        return {
          model: payload.model ?? request.model ?? config.embeddingModel,
          vectors,
          rawJson: payloadText,
        };
      } catch (error) {
        if (error instanceof LlmRequestError) {
          throw error;
        }

        if (isTimeoutError(error)) {
          throw new LlmRequestError(
            `Ollama embeddings timed out after ${request.timeoutMs ?? config.requestTimeoutMs}ms`,
            504,
            { cause: error },
          );
        }

        throw new LlmRequestError("Ollama embeddings failed", 502, {
          cause: error,
        });
      }
    },
  };
}
