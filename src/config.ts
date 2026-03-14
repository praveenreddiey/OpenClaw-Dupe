import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

export type AppConfig = {
  server: {
    host: string;
    port: number;
  };
  logger: {
    level: string;
  };
  database: {
    path: string;
  };
  llm: {
    provider: "openai";
    model: string;
    embeddingModel: string;
    apiKey: string;
    baseUrl: string;
    requestTimeoutMs: number;
    maxPromptChars: number;
    maxResponseTokens: number;
    plannerMaxResponseTokens: number;
    streamUpdateIntervalMs: number;
  };
  telegram: {
    botToken: string;
    webhookPath: string;
    webhookSecret: string;
    requestTimeoutMs: number;
    rateLimitWindowMs: number;
    rateLimitMaxRequests: number;
  };
  liveLookup: {
    provider: "none" | "openai_search";
    apiKey: string;
    baseUrl: string;
    model: string;
    requestTimeoutMs: number;
    maxOutputTokens: number;
  };
};

const defaults: AppConfig = {
  server: {
    host: "0.0.0.0",
    port: 3000,
  },
  logger: {
    level: "info",
  },
  database: {
    path: "./data/claw-dupe.db",
  },
  llm: {
    provider: "openai",
    model: "gpt-5-mini",
    embeddingModel: "text-embedding-3-small",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    requestTimeoutMs: 15000,
    maxPromptChars: 4000,
    maxResponseTokens: 400,
    plannerMaxResponseTokens: 120,
    streamUpdateIntervalMs: 750,
  },
  telegram: {
    botToken: "",
    webhookPath: "/telegram/webhook",
    webhookSecret: "",
    requestTimeoutMs: 5000,
    rateLimitWindowMs: 60000,
    rateLimitMaxRequests: 10,
  },
  liveLookup: {
    provider: "openai_search",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-search-preview",
    requestTimeoutMs: 5000,
    maxOutputTokens: 500,
  },
};

function readString(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }

  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function readPort(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function validateRuntimeConfig(config: AppConfig): void {
  const errors: string[] = [];

  if (!config.telegram.botToken) {
    errors.push("telegram.botToken is required to start the Telegram webhook server");
  }

  if (config.llm.provider !== "openai") {
    errors.push("llm.provider must be 'openai'");
  }

  if (!config.llm.apiKey) {
    errors.push("llm.apiKey or OPENAI_API_KEY is required to start the LLM adapter");
  }

  if (!config.llm.baseUrl.startsWith("http://") && !config.llm.baseUrl.startsWith("https://")) {
    errors.push("llm.baseUrl must start with 'http://' or 'https://'");
  }

  if (!Number.isInteger(config.llm.requestTimeoutMs) || config.llm.requestTimeoutMs <= 0) {
    errors.push("llm.requestTimeoutMs must be a positive integer");
  }

  if (!Number.isInteger(config.llm.maxPromptChars) || config.llm.maxPromptChars <= 0) {
    errors.push("llm.maxPromptChars must be a positive integer");
  }

  if (!Number.isInteger(config.llm.maxResponseTokens) || config.llm.maxResponseTokens <= 0) {
    errors.push("llm.maxResponseTokens must be a positive integer");
  }

  if (
    !Number.isInteger(config.llm.plannerMaxResponseTokens) ||
    config.llm.plannerMaxResponseTokens <= 0
  ) {
    errors.push("llm.plannerMaxResponseTokens must be a positive integer");
  }

  if (
    !Number.isInteger(config.llm.streamUpdateIntervalMs) ||
    config.llm.streamUpdateIntervalMs <= 0
  ) {
    errors.push("llm.streamUpdateIntervalMs must be a positive integer");
  }

  if (!config.telegram.webhookPath.startsWith("/")) {
    errors.push("telegram.webhookPath must start with '/'");
  }

  if (!Number.isInteger(config.telegram.requestTimeoutMs) || config.telegram.requestTimeoutMs <= 0) {
    errors.push("telegram.requestTimeoutMs must be a positive integer");
  }

  if (
    !Number.isInteger(config.telegram.rateLimitWindowMs) ||
    config.telegram.rateLimitWindowMs <= 0
  ) {
    errors.push("telegram.rateLimitWindowMs must be a positive integer");
  }

  if (
    !Number.isInteger(config.telegram.rateLimitMaxRequests) ||
    config.telegram.rateLimitMaxRequests <= 0
  ) {
    errors.push("telegram.rateLimitMaxRequests must be a positive integer");
  }

  if (config.liveLookup.provider !== "none" && config.liveLookup.provider !== "openai_search") {
    errors.push("liveLookup.provider must be 'none' or 'openai_search'");
  }

  if (
    config.liveLookup.provider === "openai_search" &&
    !config.liveLookup.apiKey
  ) {
    errors.push("liveLookup.apiKey or OPENAI_API_KEY is required when liveLookup.provider is 'openai_search'");
  }

  if (
    !config.liveLookup.baseUrl.startsWith("http://") &&
    !config.liveLookup.baseUrl.startsWith("https://")
  ) {
    errors.push("liveLookup.baseUrl must start with 'http://' or 'https://'");
  }

  if (
    !Number.isInteger(config.liveLookup.requestTimeoutMs) ||
    config.liveLookup.requestTimeoutMs <= 0
  ) {
    errors.push("liveLookup.requestTimeoutMs must be a positive integer");
  }

  if (
    config.liveLookup.provider !== "none" &&
    !config.liveLookup.model
  ) {
    errors.push("liveLookup.model is required when liveLookup.provider is enabled");
  }

  if (
    !Number.isInteger(config.liveLookup.maxOutputTokens) ||
    config.liveLookup.maxOutputTokens <= 0
  ) {
    errors.push("liveLookup.maxOutputTokens must be a positive integer");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid runtime config: ${errors.join("; ")}`);
  }
}

export async function loadConfig(
  configPath = process.env.CONFIG_PATH ?? "config.yaml",
): Promise<AppConfig> {
  const resolved = path.resolve(process.cwd(), configPath);

  try {
    const file = await fs.readFile(resolved, "utf8");
    const parsed = (parse(file) as Partial<AppConfig>) ?? {};

    return {
      server: {
        host: readString(parsed.server?.host, defaults.server.host),
        port: readPort(parsed.server?.port, defaults.server.port),
      },
      logger: {
        level: readString(parsed.logger?.level, defaults.logger.level),
      },
      database: {
        path: readString(parsed.database?.path, defaults.database.path),
      },
      llm: {
        provider: readString(
          process.env.LLM_PROVIDER ?? parsed.llm?.provider,
          defaults.llm.provider,
        ) as "openai",
        model: readString(
          process.env.LLM_MODEL ?? parsed.llm?.model,
          defaults.llm.model,
        ),
        embeddingModel: readString(
          process.env.LLM_EMBEDDING_MODEL ?? parsed.llm?.embeddingModel,
          defaults.llm.embeddingModel,
        ),
        apiKey: readString(
          process.env.OPENAI_API_KEY ??
            process.env.LLM_API_KEY ??
            parsed.llm?.apiKey,
          defaults.llm.apiKey,
        ),
        baseUrl: readString(
          process.env.OPENAI_BASE_URL ??
            process.env.LLM_BASE_URL ??
            parsed.llm?.baseUrl,
          defaults.llm.baseUrl,
        ),
        requestTimeoutMs: readPositiveInteger(
          process.env.LLM_REQUEST_TIMEOUT_MS ?? parsed.llm?.requestTimeoutMs,
          defaults.llm.requestTimeoutMs,
        ),
        maxPromptChars: readPositiveInteger(
          process.env.LLM_MAX_PROMPT_CHARS ?? parsed.llm?.maxPromptChars,
          defaults.llm.maxPromptChars,
        ),
        maxResponseTokens: readPositiveInteger(
          process.env.LLM_MAX_RESPONSE_TOKENS ?? parsed.llm?.maxResponseTokens,
          defaults.llm.maxResponseTokens,
        ),
        plannerMaxResponseTokens: readPositiveInteger(
          process.env.LLM_PLANNER_MAX_RESPONSE_TOKENS ??
            parsed.llm?.plannerMaxResponseTokens,
          defaults.llm.plannerMaxResponseTokens,
        ),
        streamUpdateIntervalMs: readPositiveInteger(
          process.env.LLM_STREAM_UPDATE_INTERVAL_MS ??
            parsed.llm?.streamUpdateIntervalMs,
          defaults.llm.streamUpdateIntervalMs,
        ),
      },
      telegram: {
        botToken: readString(
          process.env.TELEGRAM_BOT_TOKEN ?? parsed.telegram?.botToken,
          defaults.telegram.botToken,
        ),
        webhookPath: readString(
          parsed.telegram?.webhookPath,
          defaults.telegram.webhookPath,
        ),
        webhookSecret: readString(
          process.env.TELEGRAM_WEBHOOK_SECRET ?? parsed.telegram?.webhookSecret,
          defaults.telegram.webhookSecret,
        ),
        requestTimeoutMs: readPositiveInteger(
          parsed.telegram?.requestTimeoutMs,
          defaults.telegram.requestTimeoutMs,
        ),
        rateLimitWindowMs: readPositiveInteger(
          parsed.telegram?.rateLimitWindowMs,
          defaults.telegram.rateLimitWindowMs,
        ),
        rateLimitMaxRequests: readPositiveInteger(
          parsed.telegram?.rateLimitMaxRequests,
          defaults.telegram.rateLimitMaxRequests,
        ),
      },
      liveLookup: {
        provider: readString(
          process.env.LIVE_LOOKUP_PROVIDER ?? parsed.liveLookup?.provider,
          defaults.liveLookup.provider,
        ) as "none" | "openai_search",
        apiKey: readString(
          process.env.OPENAI_API_KEY ??
            process.env.LIVE_LOOKUP_API_KEY ??
            parsed.liveLookup?.apiKey,
          defaults.liveLookup.apiKey,
        ),
        baseUrl: readString(
          process.env.OPENAI_BASE_URL ??
            process.env.LIVE_LOOKUP_BASE_URL ??
            parsed.liveLookup?.baseUrl,
          defaults.liveLookup.baseUrl,
        ),
        model: readString(
          process.env.LIVE_LOOKUP_MODEL ?? parsed.liveLookup?.model,
          defaults.liveLookup.model,
        ),
        requestTimeoutMs: readPositiveInteger(
          process.env.LIVE_LOOKUP_REQUEST_TIMEOUT_MS ??
            parsed.liveLookup?.requestTimeoutMs,
          defaults.liveLookup.requestTimeoutMs,
        ),
        maxOutputTokens: readPositiveInteger(
          process.env.LIVE_LOOKUP_MAX_OUTPUT_TOKENS ??
            parsed.liveLookup?.maxOutputTokens,
          defaults.liveLookup.maxOutputTokens,
        ),
      },
    };
  } catch (error) {
    console.warn(
      `[config] Using defaults because ${resolved} could not be read:`,
      (error as Error).message,
    );

    return {
      ...defaults,
      llm: {
        ...defaults.llm,
        apiKey: readString(
          process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY,
          defaults.llm.apiKey,
        ),
        model: readString(
          process.env.LLM_MODEL,
          defaults.llm.model,
        ),
        embeddingModel: readString(
          process.env.LLM_EMBEDDING_MODEL,
          defaults.llm.embeddingModel,
        ),
        baseUrl: readString(
          process.env.OPENAI_BASE_URL ?? process.env.LLM_BASE_URL,
          defaults.llm.baseUrl,
        ),
        requestTimeoutMs: readPositiveInteger(
          process.env.LLM_REQUEST_TIMEOUT_MS,
          defaults.llm.requestTimeoutMs,
        ),
        maxPromptChars: readPositiveInteger(
          process.env.LLM_MAX_PROMPT_CHARS,
          defaults.llm.maxPromptChars,
        ),
        maxResponseTokens: readPositiveInteger(
          process.env.LLM_MAX_RESPONSE_TOKENS,
          defaults.llm.maxResponseTokens,
        ),
        plannerMaxResponseTokens: readPositiveInteger(
          process.env.LLM_PLANNER_MAX_RESPONSE_TOKENS,
          defaults.llm.plannerMaxResponseTokens,
        ),
        streamUpdateIntervalMs: readPositiveInteger(
          process.env.LLM_STREAM_UPDATE_INTERVAL_MS,
          defaults.llm.streamUpdateIntervalMs,
        ),
      },
      telegram: {
        ...defaults.telegram,
        botToken: readString(
          process.env.TELEGRAM_BOT_TOKEN,
          defaults.telegram.botToken,
        ),
        webhookSecret: readString(
          process.env.TELEGRAM_WEBHOOK_SECRET,
          defaults.telegram.webhookSecret,
        ),
        requestTimeoutMs: defaults.telegram.requestTimeoutMs,
        rateLimitWindowMs: defaults.telegram.rateLimitWindowMs,
        rateLimitMaxRequests: defaults.telegram.rateLimitMaxRequests,
      },
      liveLookup: {
        ...defaults.liveLookup,
        provider: readString(
          process.env.LIVE_LOOKUP_PROVIDER,
          defaults.liveLookup.provider,
        ) as "none" | "openai_search",
        apiKey: readString(
          process.env.OPENAI_API_KEY ?? process.env.LIVE_LOOKUP_API_KEY,
          defaults.liveLookup.apiKey,
        ),
        baseUrl: readString(
          process.env.OPENAI_BASE_URL ?? process.env.LIVE_LOOKUP_BASE_URL,
          defaults.liveLookup.baseUrl,
        ),
        model: readString(
          process.env.LIVE_LOOKUP_MODEL,
          defaults.liveLookup.model,
        ),
        requestTimeoutMs: readPositiveInteger(
          process.env.LIVE_LOOKUP_REQUEST_TIMEOUT_MS,
          defaults.liveLookup.requestTimeoutMs,
        ),
        maxOutputTokens: readPositiveInteger(
          process.env.LIVE_LOOKUP_MAX_OUTPUT_TOKENS,
          defaults.liveLookup.maxOutputTokens,
        ),
      },
    };
  }
}
