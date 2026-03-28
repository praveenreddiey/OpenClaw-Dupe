import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWebhookUrl,
  extractLatestTryCloudflareUrl,
  isRetryableWebhookErrorMessage,
  parseEnvFile,
} from "../src/redeploy.js";

test("parseEnvFile keeps simple env entries and strips quotes", () => {
  const parsed = parseEnvFile(`
# comment
TELEGRAM_BOT_TOKEN="bot-token"
OPENAI_API_KEY='openai-key'
PLAIN_VALUE=no-quotes
`);

  assert.deepEqual(parsed, {
    TELEGRAM_BOT_TOKEN: "bot-token",
    OPENAI_API_KEY: "openai-key",
    PLAIN_VALUE: "no-quotes",
  });
});

test("extractLatestTryCloudflareUrl returns the newest tunnel URL from logs", () => {
  const logOutput = `
INFO first tunnel https://old.trycloudflare.com
INFO replacement tunnel https://new-url.trycloudflare.com
`;

  assert.equal(
    extractLatestTryCloudflareUrl(logOutput),
    "https://new-url.trycloudflare.com",
  );
});

test("extractLatestTryCloudflareUrl returns null when tunnel logs do not contain a url", () => {
  assert.equal(extractLatestTryCloudflareUrl("no url here"), null);
});

test("buildWebhookUrl appends the Telegram webhook path", () => {
  assert.equal(
    buildWebhookUrl("https://demo.trycloudflare.com", "/telegram/webhook"),
    "https://demo.trycloudflare.com/telegram/webhook",
  );
});

test("isRetryableWebhookErrorMessage detects tunnel dns propagation failures", () => {
  assert.equal(
    isRetryableWebhookErrorMessage(
      "Telegram setWebhook failed: 400 {\"description\":\"Bad Request: bad webhook: Failed to resolve host: Name or service not known\"}",
    ),
    true,
  );
  assert.equal(
    isRetryableWebhookErrorMessage("Telegram setWebhook failed: 400 bad webhook: wrong port"),
    false,
  );
});
