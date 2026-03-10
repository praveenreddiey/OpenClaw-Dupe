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
  telegram: {
    botToken: string;
    webhookPath: string;
    webhookSecret: string;
    requestTimeoutMs: number;
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
  telegram: {
    botToken: "",
    webhookPath: "/telegram/webhook",
    webhookSecret: "",
    requestTimeoutMs: 5000,
  },
};

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
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

  if (!config.telegram.webhookPath.startsWith("/")) {
    errors.push("telegram.webhookPath must start with '/'");
  }

  if (!Number.isInteger(config.telegram.requestTimeoutMs) || config.telegram.requestTimeoutMs <= 0) {
    errors.push("telegram.requestTimeoutMs must be a positive integer");
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
      },
    };
  } catch (error) {
    console.warn(
      `[config] Using defaults because ${resolved} could not be read:`,
      (error as Error).message,
    );

    return {
      ...defaults,
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
      },
    };
  }
}
