import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../src/config.js";
import {
  buildWebhookUrl,
  extractLatestTryCloudflareUrl,
  isRetryableWebhookErrorMessage,
  parseEnvFile,
} from "../src/redeploy.js";

const tunnelPollAttempts = 30;
const tunnelPollDelayMs = 2000;
const webhookRetryAttempts = 30;
const webhookRetryDelayMs = 5000;

type CommandResult = {
  stdout: string;
  stderr: string;
};

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    captureOutput?: boolean;
  },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.captureOutput ? "pipe" : "inherit",
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    if (options.captureOutput) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const reason = options.captureOutput
        ? (stderr.trim() || stdout.trim() || `exit code ${code}`)
        : `exit code ${code}`;
      reject(new Error(`${command} ${args.join(" ")} failed: ${reason}`));
    });
  });
}

async function waitForTunnelUrl(cwd: string): Promise<string> {
  for (let attempt = 0; attempt < tunnelPollAttempts; attempt += 1) {
    const { stdout, stderr } = await runCommand(
      "docker",
      ["compose", "--env-file", ".env", "logs", "--tail", "200", "tunnel"],
      { cwd, captureOutput: true },
    );

    const tunnelUrl = extractLatestTryCloudflareUrl(`${stdout}\n${stderr}`);
    if (tunnelUrl) {
      return tunnelUrl;
    }

    await delay(tunnelPollDelayMs);
  }

  throw new Error("Could not find a Cloudflare tunnel URL in the tunnel logs");
}

async function setTelegramWebhook(
  token: string,
  webhookUrl: string,
  webhookSecret: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    url: webhookUrl,
    drop_pending_updates: true,
    allowed_updates: ["message", "edited_message"],
  };

  if (webhookSecret) {
    body.secret_token = webhookSecret;
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Telegram setWebhook failed: ${response.status} ${responseBody}`);
  }

  const payload = await response.json() as { ok?: boolean; description?: string };
  if (!payload.ok) {
    throw new Error(
      `Telegram setWebhook rejected the request: ${payload.description ?? "unknown error"}`,
    );
  }
}

async function setTelegramWebhookWithRetry(
  token: string,
  webhookUrl: string,
  webhookSecret: string,
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= webhookRetryAttempts; attempt += 1) {
    try {
      await setTelegramWebhook(token, webhookUrl, webhookSecret);
      return;
    } catch (error) {
      const resolvedError = error instanceof Error ? error : new Error(String(error));
      lastError = resolvedError;

      if (!isRetryableWebhookErrorMessage(resolvedError.message) || attempt === webhookRetryAttempts) {
        throw resolvedError;
      }

      console.log(
        `[webhook:update] webhook host is not reachable yet, retrying (${attempt}/${webhookRetryAttempts})`,
      );
      await delay(webhookRetryDelayMs);
    }
  }

  throw lastError ?? new Error("Telegram setWebhook failed");
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const envPath = path.join(cwd, ".env");
  const envFile = await readFile(envPath, "utf8");
  const envMap = parseEnvFile(envFile);

  for (const [key, value] of Object.entries(envMap)) {
    process.env[key] = value;
  }

  const config = await loadConfig();
  const token = config.telegram.botToken.trim();
  if (!token) {
    throw new Error("telegram.botToken or TELEGRAM_BOT_TOKEN is required");
  }

  console.log("[webhook:update] waiting for Cloudflare tunnel URL");
  const tunnelBaseUrl = await waitForTunnelUrl(cwd);
  const webhookUrl = buildWebhookUrl(tunnelBaseUrl, config.telegram.webhookPath);

  console.log("[webhook:update] updating Telegram webhook");
  await setTelegramWebhookWithRetry(token, webhookUrl, config.telegram.webhookSecret);

  console.log(`[webhook:update] webhook updated to ${webhookUrl}`);
  console.log(
    `[webhook:update] webhook secret ${config.telegram.webhookSecret ? "configured" : "not configured"}`,
  );
}

void main().catch((error) => {
  console.error("[webhook:update] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

