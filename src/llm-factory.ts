import type { AppConfig } from "./config.js";
import type { LlmClient } from "./llm.js";
import { createOllamaLlmClient } from "./ollama-llm.js";
import { createOpenAILlmClient } from "./openai-llm.js";

export function createLlmClient(config: AppConfig["llm"]): LlmClient {
  if (config.provider === "ollama") {
    return createOllamaLlmClient({
      baseUrl: config.baseUrl,
      model: config.model,
      embeddingModel: config.embeddingModel,
      requestTimeoutMs: config.requestTimeoutMs,
    });
  }

  return createOpenAILlmClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    embeddingModel: config.embeddingModel,
    requestTimeoutMs: config.requestTimeoutMs,
  });
}
