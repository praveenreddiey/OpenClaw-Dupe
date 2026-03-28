import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { validateCronExpression } from "./cron.js";
import {
  isMutatingShellCommand,
  resolveShellWorkingDirectory,
  validateShellAllowlistEntry,
  type ShellAllowlistEntry,
} from "./shell-policy.js";

export type ScheduledTaskConfig = {
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  maxOutputTokens: number;
  telegramChatId?: string;
  runOnce?: boolean;
};

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
    provider: "openai" | "ollama";
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
  skills: {
    enabled: boolean;
    timeoutMs: number;
    maxOldGenerationSizeMb: number;
    maxReadBytes: number;
    maxWriteBytes: number;
    allowedPaths: string[];
    blockedPaths: string[];
    shellEnabled: boolean;
    shellWorkingDirectory: string;
    shellMaxOutputBytes: number;
    shellAllowlist: ShellAllowlistEntry[];
  };
  scheduler: {
    enabled: boolean;
    pollIntervalMs: number;
    runTimeoutMs: number;
    rateLimitWindowMs: number;
    rateLimitMaxRuns: number;
    tasks: ScheduledTaskConfig[];
  };
  viewer: {
    enabled: boolean;
    path: string;
    taskRunLimit: number;
    auditLogLimit: number;
  };
};

const defaultShellAllowlist: ShellAllowlistEntry[] = [
  {
    command: "git status --short",
    requiresConfirmation: false,
    description: "Show the current repo status",
  },
  {
    command: "npm test",
    requiresConfirmation: false,
    description: "Run the project test suite",
  },
  {
    command: "npm run build",
    requiresConfirmation: true,
    description: "Build the project output",
  },
];

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
  skills: {
    enabled: true,
    timeoutMs: 2000,
    maxOldGenerationSizeMb: 64,
    maxReadBytes: 65536,
    maxWriteBytes: 65536,
    allowedPaths: ["./"],
    blockedPaths: [
      "./.env",
      "./config.yaml",
      "./.git",
      "./node_modules",
      "./dist",
    ],
    shellEnabled: true,
    shellWorkingDirectory: "./",
    shellMaxOutputBytes: 16384,
    shellAllowlist: defaultShellAllowlist,
  },
  scheduler: {
    enabled: false,
    pollIntervalMs: 10000,
    runTimeoutMs: 30000,
    rateLimitWindowMs: 60000,
    rateLimitMaxRuns: 2,
    tasks: [],
  },
  viewer: {
    enabled: true,
    path: "/logs",
    taskRunLimit: 25,
    auditLogLimit: 50,
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

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }

    if (normalized === "false") {
      return false;
    }
  }

  return fallback;
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const entries = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return entries.length > 0 ? entries : fallback;
  }

  if (typeof value === "string") {
    const entries = value
      .split(/[;\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    return entries.length > 0 ? entries : fallback;
  }

  return fallback;
}

function readLlmProvider(value: unknown, fallback: AppConfig["llm"]["provider"]): AppConfig["llm"]["provider"] {
  const normalized = readString(value, fallback);
  return normalized === "ollama" ? "ollama" : "openai";
}

function readLiveLookupProvider(
  value: unknown,
  fallback: AppConfig["liveLookup"]["provider"],
): AppConfig["liveLookup"]["provider"] {
  const normalized = readString(value, fallback);
  return normalized === "none" ? "none" : "openai_search";
}

function readShellAllowlist(
  value: unknown,
  fallback: ShellAllowlistEntry[],
): ShellAllowlistEntry[] {
  if (Array.isArray(value)) {
    const entries = value.flatMap((entry) => {
      if (typeof entry === "string") {
        const command = entry.trim();
        if (!command) {
          return [];
        }

        return [{
          command,
          requiresConfirmation: isMutatingShellCommand(command),
        }];
      }

      if (entry && typeof entry === "object") {
        const command = readString(
          "command" in entry ? entry.command : undefined,
          "",
        );
        if (!command) {
          return [];
        }

        return [{
          command,
          requiresConfirmation: readBoolean(
            "requiresConfirmation" in entry
              ? entry.requiresConfirmation
              : undefined,
            isMutatingShellCommand(command),
          ),
          description: readString(
            "description" in entry ? entry.description : undefined,
            "",
          ) || undefined,
        }];
      }

      return [];
    });

    return entries.length > 0 ? entries : fallback;
  }

  if (typeof value === "string") {
    const commands = value
      .split(/[;\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (commands.length === 0) {
      return fallback;
    }

    return commands.map((command) => ({
      command,
      requiresConfirmation: isMutatingShellCommand(command),
    }));
  }

  return fallback;
}

function readSchedulerTasks(
  value: unknown,
  fallback: ScheduledTaskConfig[],
  defaultMaxOutputTokens: number,
): ScheduledTaskConfig[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const tasks = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const name = readString("name" in entry ? entry.name : undefined, "");
    const schedule = readString(
      "schedule" in entry ? entry.schedule : undefined,
      "",
    );
    const prompt = readString("prompt" in entry ? entry.prompt : undefined, "");
    if (!name || !schedule || !prompt) {
      return [];
    }

    return [{
      name,
      schedule,
      prompt,
      enabled: readBoolean(
        "enabled" in entry ? entry.enabled : undefined,
        true,
      ),
      maxOutputTokens: readPositiveInteger(
        "maxOutputTokens" in entry ? entry.maxOutputTokens : undefined,
        defaultMaxOutputTokens,
      ),
      telegramChatId: readString(
        "telegramChatId" in entry ? entry.telegramChatId : undefined,
        "",
      ) || undefined,
      runOnce: readBoolean(
        "runOnce" in entry ? entry.runOnce : undefined,
        false,
      ),
    }];
  });

  return tasks.length > 0 ? tasks : fallback;
}

function isFilesystemRootPath(inputPath: string): boolean {
  const resolved = path.resolve(process.cwd(), inputPath);
  return path.parse(resolved).root === resolved;
}

function normalizeForComparison(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInsideScope(candidatePath: string, scopePath: string): boolean {
  const normalizedCandidate = normalizeForComparison(candidatePath);
  const normalizedScope = normalizeForComparison(scopePath);
  return normalizedCandidate === normalizedScope ||
    normalizedCandidate.startsWith(`${normalizedScope}${path.sep}`);
}

function readParsedConfig(raw: unknown): Partial<AppConfig> {
  return (raw as Partial<AppConfig>) ?? {};
}

export function validateRuntimeConfig(config: AppConfig): void {
  const errors: string[] = [];

  if (!config.telegram.botToken) {
    errors.push("telegram.botToken is required to start the Telegram webhook server");
  }

  if (config.llm.provider !== "openai" && config.llm.provider !== "ollama") {
    errors.push("llm.provider must be 'openai' or 'ollama'");
  }

  if (!config.llm.model) {
    errors.push("llm.model is required");
  }

  if (!config.llm.embeddingModel) {
    errors.push("llm.embeddingModel is required");
  }

  if (config.llm.provider === "openai" && !config.llm.apiKey) {
    errors.push("llm.apiKey or OPENAI_API_KEY is required when llm.provider is 'openai'");
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

  if (config.liveLookup.provider === "openai_search" && !config.liveLookup.apiKey) {
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

  if (config.liveLookup.provider !== "none" && !config.liveLookup.model) {
    errors.push("liveLookup.model is required when liveLookup.provider is enabled");
  }

  if (
    !Number.isInteger(config.liveLookup.maxOutputTokens) ||
    config.liveLookup.maxOutputTokens <= 0
  ) {
    errors.push("liveLookup.maxOutputTokens must be a positive integer");
  }

  if (!Number.isInteger(config.skills.timeoutMs) || config.skills.timeoutMs <= 0) {
    errors.push("skills.timeoutMs must be a positive integer");
  }

  if (
    !Number.isInteger(config.skills.maxOldGenerationSizeMb) ||
    config.skills.maxOldGenerationSizeMb <= 0
  ) {
    errors.push("skills.maxOldGenerationSizeMb must be a positive integer");
  }

  if (!Number.isInteger(config.skills.maxReadBytes) || config.skills.maxReadBytes <= 0) {
    errors.push("skills.maxReadBytes must be a positive integer");
  }

  if (!Number.isInteger(config.skills.maxWriteBytes) || config.skills.maxWriteBytes <= 0) {
    errors.push("skills.maxWriteBytes must be a positive integer");
  }

  if (config.skills.enabled && config.skills.allowedPaths.length === 0) {
    errors.push("skills.allowedPaths must include at least one path when skills are enabled");
  }

  if (config.skills.allowedPaths.some((entry) => !entry.trim())) {
    errors.push("skills.allowedPaths entries must be non-empty strings");
  }

  if (config.skills.blockedPaths.some((entry) => !entry.trim())) {
    errors.push("skills.blockedPaths entries must be non-empty strings");
  }

  if (config.skills.allowedPaths.some((entry) => isFilesystemRootPath(entry))) {
    errors.push("skills.allowedPaths must not include a filesystem root");
  }

  if (config.skills.blockedPaths.some((entry) => isFilesystemRootPath(entry))) {
    errors.push("skills.blockedPaths must not include a filesystem root");
  }

  if (!Number.isInteger(config.skills.shellMaxOutputBytes) || config.skills.shellMaxOutputBytes <= 0) {
    errors.push("skills.shellMaxOutputBytes must be a positive integer");
  }

  if (config.skills.shellEnabled) {
    try {
      const resolvedShellCwd = resolveShellWorkingDirectory(
        process.cwd(),
        config.skills.shellWorkingDirectory,
      );
      const allowedShellCwd = config.skills.allowedPaths.some((entry) =>
        isPathInsideScope(resolvedShellCwd, path.resolve(process.cwd(), entry))
      );
      if (!allowedShellCwd) {
        errors.push("skills.shellWorkingDirectory must stay inside skills.allowedPaths");
      }

      const blockedShellCwd = config.skills.blockedPaths.some((entry) =>
        isPathInsideScope(resolvedShellCwd, path.resolve(process.cwd(), entry))
      );
      if (blockedShellCwd) {
        errors.push("skills.shellWorkingDirectory must not point inside skills.blockedPaths");
      }
    } catch (error) {
      errors.push(getValidationMessage(error));
    }

    if (config.skills.shellAllowlist.length === 0) {
      errors.push("skills.shellAllowlist must include at least one command when shell is enabled");
    }

    for (const entry of config.skills.shellAllowlist) {
      try {
        validateShellAllowlistEntry(entry);
      } catch (error) {
        errors.push(getValidationMessage(error));
      }
    }
  }

  if (!Number.isInteger(config.scheduler.pollIntervalMs) || config.scheduler.pollIntervalMs <= 0) {
    errors.push("scheduler.pollIntervalMs must be a positive integer");
  }

  if (!Number.isInteger(config.scheduler.runTimeoutMs) || config.scheduler.runTimeoutMs <= 0) {
    errors.push("scheduler.runTimeoutMs must be a positive integer");
  }

  if (
    !Number.isInteger(config.scheduler.rateLimitWindowMs) ||
    config.scheduler.rateLimitWindowMs <= 0
  ) {
    errors.push("scheduler.rateLimitWindowMs must be a positive integer");
  }

  if (
    !Number.isInteger(config.scheduler.rateLimitMaxRuns) ||
    config.scheduler.rateLimitMaxRuns <= 0
  ) {
    errors.push("scheduler.rateLimitMaxRuns must be a positive integer");
  }

  const taskNames = new Set<string>();
  for (const task of config.scheduler.tasks) {
    if (!task.name.trim()) {
      errors.push("scheduler.tasks[].name must be a non-empty string");
    }

    if (taskNames.has(task.name)) {
      errors.push(`scheduler.tasks must not contain duplicate task name '${task.name}'`);
    }
    taskNames.add(task.name);

    if (!task.prompt.trim()) {
      errors.push(`scheduler task '${task.name}' must include a prompt`);
    }

    if (!Number.isInteger(task.maxOutputTokens) || task.maxOutputTokens <= 0) {
      errors.push(`scheduler task '${task.name}' maxOutputTokens must be a positive integer`);
    }

    if (task.telegramChatId !== undefined && !task.telegramChatId.trim()) {
      errors.push(`scheduler task '${task.name}' telegramChatId must be a non-empty string when provided`);
    }

    if (task.runOnce && !task.telegramChatId) {
      errors.push(`scheduler task '${task.name}' runOnce requires telegramChatId`);
    }

    try {
      validateCronExpression(task.schedule);
    } catch (error) {
      errors.push(`scheduler task '${task.name}' has invalid schedule: ${getValidationMessage(error)}`);
    }
  }

  if (config.viewer.enabled && !config.viewer.path.startsWith("/")) {
    errors.push("viewer.path must start with '/'");
  }

  if (!Number.isInteger(config.viewer.taskRunLimit) || config.viewer.taskRunLimit <= 0) {
    errors.push("viewer.taskRunLimit must be a positive integer");
  }

  if (!Number.isInteger(config.viewer.auditLogLimit) || config.viewer.auditLogLimit <= 0) {
    errors.push("viewer.auditLogLimit must be a positive integer");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid runtime config: ${errors.join("; ")}`);
  }
}

function getValidationMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildConfigFromParsed(parsed: Partial<AppConfig>): AppConfig {
  const llmProvider = readLlmProvider(
    process.env.LLM_PROVIDER ?? parsed.llm?.provider,
    defaults.llm.provider,
  );
  const defaultBaseUrl = llmProvider === "ollama"
    ? "http://127.0.0.1:11434"
    : defaults.llm.baseUrl;
  const defaultEmbeddingModel = llmProvider === "ollama"
    ? "nomic-embed-text"
    : defaults.llm.embeddingModel;

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
      provider: llmProvider,
      model: readString(
        process.env.LLM_MODEL ?? parsed.llm?.model,
        defaults.llm.model,
      ),
      embeddingModel: readString(
        process.env.LLM_EMBEDDING_MODEL ?? parsed.llm?.embeddingModel,
        defaultEmbeddingModel,
      ),
      apiKey: readString(
        process.env.OPENAI_API_KEY ??
          process.env.LLM_API_KEY ??
          parsed.llm?.apiKey,
        defaults.llm.apiKey,
      ),
      baseUrl: readString(
        process.env.OLLAMA_BASE_URL ??
          process.env.OPENAI_BASE_URL ??
          process.env.LLM_BASE_URL ??
          parsed.llm?.baseUrl,
        defaultBaseUrl,
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
      provider: readLiveLookupProvider(
        process.env.LIVE_LOOKUP_PROVIDER ?? parsed.liveLookup?.provider,
        defaults.liveLookup.provider,
      ),
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
    skills: {
      enabled: readBoolean(
        process.env.SKILLS_ENABLED ?? parsed.skills?.enabled,
        defaults.skills.enabled,
      ),
      timeoutMs: readPositiveInteger(
        process.env.SKILLS_TIMEOUT_MS ?? parsed.skills?.timeoutMs,
        defaults.skills.timeoutMs,
      ),
      maxOldGenerationSizeMb: readPositiveInteger(
        process.env.SKILLS_MAX_OLD_GENERATION_SIZE_MB ??
          parsed.skills?.maxOldGenerationSizeMb,
        defaults.skills.maxOldGenerationSizeMb,
      ),
      maxReadBytes: readPositiveInteger(
        process.env.SKILLS_MAX_READ_BYTES ?? parsed.skills?.maxReadBytes,
        defaults.skills.maxReadBytes,
      ),
      maxWriteBytes: readPositiveInteger(
        process.env.SKILLS_MAX_WRITE_BYTES ?? parsed.skills?.maxWriteBytes,
        defaults.skills.maxWriteBytes,
      ),
      allowedPaths: readStringArray(
        process.env.SKILLS_ALLOWED_PATHS ?? parsed.skills?.allowedPaths,
        defaults.skills.allowedPaths,
      ),
      blockedPaths: readStringArray(
        process.env.SKILLS_BLOCKED_PATHS ?? parsed.skills?.blockedPaths,
        defaults.skills.blockedPaths,
      ),
      shellEnabled: readBoolean(
        process.env.SKILLS_SHELL_ENABLED ?? parsed.skills?.shellEnabled,
        defaults.skills.shellEnabled,
      ),
      shellWorkingDirectory: readString(
        process.env.SKILLS_SHELL_WORKING_DIRECTORY ??
          parsed.skills?.shellWorkingDirectory,
        defaults.skills.shellWorkingDirectory,
      ),
      shellMaxOutputBytes: readPositiveInteger(
        process.env.SKILLS_SHELL_MAX_OUTPUT_BYTES ??
          parsed.skills?.shellMaxOutputBytes,
        defaults.skills.shellMaxOutputBytes,
      ),
      shellAllowlist: readShellAllowlist(
        process.env.SKILLS_SHELL_ALLOWLIST ?? parsed.skills?.shellAllowlist,
        defaults.skills.shellAllowlist,
      ),
    },
    scheduler: {
      enabled: readBoolean(
        process.env.SCHEDULER_ENABLED ?? parsed.scheduler?.enabled,
        defaults.scheduler.enabled,
      ),
      pollIntervalMs: readPositiveInteger(
        process.env.SCHEDULER_POLL_INTERVAL_MS ?? parsed.scheduler?.pollIntervalMs,
        defaults.scheduler.pollIntervalMs,
      ),
      runTimeoutMs: readPositiveInteger(
        process.env.SCHEDULER_RUN_TIMEOUT_MS ?? parsed.scheduler?.runTimeoutMs,
        defaults.scheduler.runTimeoutMs,
      ),
      rateLimitWindowMs: readPositiveInteger(
        process.env.SCHEDULER_RATE_LIMIT_WINDOW_MS ??
          parsed.scheduler?.rateLimitWindowMs,
        defaults.scheduler.rateLimitWindowMs,
      ),
      rateLimitMaxRuns: readPositiveInteger(
        process.env.SCHEDULER_RATE_LIMIT_MAX_RUNS ??
          parsed.scheduler?.rateLimitMaxRuns,
        defaults.scheduler.rateLimitMaxRuns,
      ),
      tasks: readSchedulerTasks(
        parsed.scheduler?.tasks,
        defaults.scheduler.tasks,
        defaults.llm.maxResponseTokens,
      ),
    },
    viewer: {
      enabled: readBoolean(
        process.env.VIEWER_ENABLED ?? parsed.viewer?.enabled,
        defaults.viewer.enabled,
      ),
      path: readString(
        process.env.VIEWER_PATH ?? parsed.viewer?.path,
        defaults.viewer.path,
      ),
      taskRunLimit: readPositiveInteger(
        process.env.VIEWER_TASK_RUN_LIMIT ?? parsed.viewer?.taskRunLimit,
        defaults.viewer.taskRunLimit,
      ),
      auditLogLimit: readPositiveInteger(
        process.env.VIEWER_AUDIT_LOG_LIMIT ?? parsed.viewer?.auditLogLimit,
        defaults.viewer.auditLogLimit,
      ),
    },
  };
}

export async function loadConfig(
  configPath = process.env.CONFIG_PATH ?? "config.yaml",
): Promise<AppConfig> {
  const resolved = path.resolve(process.cwd(), configPath);

  try {
    const file = await fs.readFile(resolved, "utf8");
    return buildConfigFromParsed(readParsedConfig(parse(file)));
  } catch (error) {
    console.warn(
      `[config] Using defaults because ${resolved} could not be read:`,
      (error as Error).message,
    );

    return buildConfigFromParsed({});
  }
}
