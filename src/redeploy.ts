function stripSurroundingQuotes(value: string): string {
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

export function parseEnvFile(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1);
    if (!key) {
      continue;
    }

    parsed[key] = stripSurroundingQuotes(value);
  }

  return parsed;
}

export function extractLatestTryCloudflareUrl(logOutput: string): string | null {
  const matches = [...logOutput.matchAll(/https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/g)];
  return matches.at(-1)?.[0] ?? null;
}

export function buildWebhookUrl(baseUrl: string, webhookPath: string): string {
  return new URL(webhookPath, baseUrl).toString();
}

export function isRetryableWebhookErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("failed to resolve host") ||
    normalized.includes("name or service not known");
}
