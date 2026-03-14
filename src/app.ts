import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import {
  createMessageStore,
  type MessageRecord,
  type MessageStore,
  type MessageUpdate,
} from "./db.js";
import { LlmRequestError, type LlmClient, type LlmMessage } from "./llm.js";
import type { MessageAdapter, UnifiedMessage } from "./messages.js";
import { createOpenAILlmClient } from "./openai-llm.js";
import {
  buildResponseMessages,
  createReplyPlan,
  isRecommendationRequest,
  type ReplyPlan,
} from "./planner.js";
import {
  buildBestGuessFallbackContext,
  buildLiveLookupRequestText,
  buildVerifiedLiveFailureReply,
  createLiveLookupClient,
  isWeakLiveLookupAnswer,
  requiresVerifiedLiveAnswer,
  shouldUseLiveLookup,
  type LiveLookupClient,
} from "./live-lookup.js";
import {
  createTelegramClient,
  TelegramAdapter,
  TelegramDeliveryError,
  type TelegramClient,
} from "./telegram-adapter.js";

export {
  createOpenAILlmClient,
  createTelegramClient,
  TelegramAdapter,
  TelegramDeliveryError,
  LlmRequestError,
  type TelegramClient,
};
export type { LlmClient } from "./llm.js";
export type { MessageAdapter } from "./messages.js";

type BuildAppOptions = {
  messageStore?: MessageStore;
  messageAdapter?: MessageAdapter;
  telegramClient?: TelegramClient;
  llmClient?: LlmClient;
  liveLookupClient?: LiveLookupClient | null;
};

class MessagePersistenceError extends Error {
  readonly statusCode: number;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MessagePersistenceError";
    this.statusCode = 500;
  }
}

type RateLimitCheckResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

type RateLimiter = {
  check(key: string): RateLimitCheckResult;
};

type BackgroundReplyOptions = {
  config: AppConfig;
  logger: FastifyBaseLogger;
  llmClient: LlmClient;
  liveLookupClient: LiveLookupClient | null;
  messageAdapter: MessageAdapter;
  messageStore: MessageStore;
  incomingMessage: UnifiedMessage;
  incomingRecord: MessageRecord;
};

type LiveLookupResolution = {
  replyText: string | null;
  fallbackContext?: string;
  skipLlmFallback?: boolean;
};

const LANGUAGE_NAMES = [
  "hindi",
  "english",
  "malayalam",
  "tamil",
  "telugu",
  "kannada",
  "bengali",
  "marathi",
  "punjabi",
  "gujarati",
  "odia",
  "assamese",
];
const PLATFORM_NORMALIZATION_RULES = [
  {
    canonical: "netflix",
    label: "Netflix",
    aliases: ["netflix"],
  },
  {
    canonical: "prime video",
    label: "Prime Video",
    aliases: ["prime video", "amazon prime", "prime"],
  },
  {
    canonical: "disney+ hotstar",
    label: "Disney+ Hotstar",
    aliases: ["disney+ hotstar", "hotstar", "disney", "jiohotstar"],
  },
  {
    canonical: "max",
    label: "Max",
    aliases: ["max", "hbo"],
  },
  {
    canonical: "hulu",
    label: "Hulu",
    aliases: ["hulu"],
  },
  {
    canonical: "apple tv+",
    label: "Apple TV+",
    aliases: ["apple tv+", "apple tv", "apple"],
  },
  {
    canonical: "sony liv",
    label: "Sony LIV",
    aliases: ["sony liv", "sony", "liv"],
  },
  {
    canonical: "zee5",
    label: "ZEE5",
    aliases: ["zee5"],
  },
] as const;
const PLATFORM_TOKEN_CANDIDATES = Array.from(
  new Set(
    PLATFORM_NORMALIZATION_RULES.flatMap((rule) =>
      [rule.canonical, ...rule.aliases]
        .flatMap((phrase) => phrase.split(/\s+/))
        .map((token) => token.toLowerCase())
        .filter(Boolean),
    ),
  ),
);
const PLATFORM_ALIAS_SEQUENCES = PLATFORM_NORMALIZATION_RULES.flatMap((rule) =>
  Array.from(new Set([rule.canonical, ...rule.aliases])).map((alias) => ({
    aliasTokens: alias.toLowerCase().split(/\s+/).filter(Boolean),
    canonicalTokens: rule.canonical.toLowerCase().split(/\s+/).filter(Boolean),
  })),
).sort((left, right) => right.aliasTokens.length - left.aliasTokens.length);
const NORMALIZATION_SKIP_TOKENS = new Set([
  "best",
  "top",
  "good",
  "watch",
  "listen",
  "recommend",
  "suggest",
  "tv",
  "show",
  "shows",
  "movie",
  "movies",
  "film",
  "films",
  "song",
  "songs",
  "series",
  "book",
  "books",
  "anime",
  "restaurant",
  "restaurants",
  "place",
  "places",
  "from",
  "of",
  "in",
  "for",
  "to",
  "and",
  "the",
  ...LANGUAGE_NAMES,
]);

function createRateLimiter(windowMs: number, maxRequests: number): RateLimiter {
  const hitsByKey = new Map<string, number[]>();

  return {
    check(key) {
      const now = Date.now();
      const windowStart = now - windowMs;
      const activeHits = (hitsByKey.get(key) ?? []).filter(
        (timestamp) => timestamp > windowStart,
      );

      if (activeHits.length >= maxRequests) {
        hitsByKey.set(key, activeHits);
        const oldestHit = activeHits[0] ?? now;
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((windowMs - (now - oldestHit)) / 1000),
          ),
        };
      }

      activeHits.push(now);
      hitsByKey.set(key, activeHits);
      return {
        allowed: true,
        retryAfterSeconds: 0,
      };
    },
  };
}

function currentTimestamp(): string {
  return new Date().toISOString();
}

function parseStoredMessageId(messageId: string | null): number | null {
  if (!messageId) {
    return null;
  }

  const parsed = Number(messageId);
  return Number.isInteger(parsed) ? parsed : null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serializeErrorPayload(error: unknown): string {
  return JSON.stringify({
    name: error instanceof Error ? error.name : "Error",
    message: getErrorMessage(error),
  });
}

function insertMessageOrThrow(
  logger: FastifyBaseLogger,
  messageStore: MessageStore,
  message: Parameters<MessageStore["insertMessage"]>[0],
  context: Record<string, unknown>,
): MessageRecord {
  try {
    return messageStore.insertMessage(message);
  } catch (error) {
    logger.error({ err: error, ...context }, "failed to persist message");
    throw new MessagePersistenceError("Failed to persist message", {
      cause: error,
    });
  }
}

function updateMessageSafely(
  logger: FastifyBaseLogger,
  messageStore: MessageStore,
  id: number,
  update: MessageUpdate,
  context: Record<string, unknown>,
): MessageRecord | null {
  try {
    return messageStore.updateMessage(id, update);
  } catch (error) {
    logger.error(
      { err: error, messageId: id, ...context },
      "failed to update message",
    );
    return null;
  }
}

function truncateForPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 19))}\n[message truncated]`;
}

function redactForLog(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\+?\d[\d\s()-]{7,}\d/g, "[redacted-number]")
    .replace(/\b(?:sk|tok|key)-[A-Za-z0-9_-]+\b/g, "[redacted-token]")
    .slice(0, 500);
}

function truncateForContext(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function listRecentProcessedMessages(
  messageStore: MessageStore,
  chatId: string,
  currentIncomingId: number,
): MessageRecord[] {
  return messageStore
    .listMessagesByChat(chatId)
    .filter((message) =>
      message.id < currentIncomingId &&
      message.status === "processed" &&
      message.text.trim() &&
      message.text.trim() !== "Thinking...",
    );
}

function buildConversationContext(
  messageStore: MessageStore,
  chatId: string,
  currentIncomingId: number,
): string | undefined {
  const recentMessages = listRecentProcessedMessages(
    messageStore,
    chatId,
    currentIncomingId,
  )
    .slice(-4);

  if (recentMessages.length === 0) {
    return undefined;
  }

  return recentMessages
    .map((message) => {
      const speaker = message.direction === "incoming" ? "User" : "Assistant";
      return `${speaker}: ${truncateForContext(message.text, 280)}`;
    })
    .join("\n");
}

function levenshteinDistance(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0)
  );

  for (let row = 0; row <= left.length; row += 1) {
    rows[row][0] = row;
  }

  for (let column = 0; column <= right.length; column += 1) {
    rows[0][column] = column;
  }

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] + cost,
      );
    }
  }

  return rows[left.length][right.length];
}

function normalizeAliasSequences(
  text: string,
  sequences: ReadonlyArray<{
    aliasTokens: readonly string[];
    canonicalTokens: readonly string[];
  }>,
): string {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9+\s]+/gi, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) {
    return "";
  }

  const normalizedTokens: string[] = [];

  for (let index = 0; index < tokens.length;) {
    const matchedSequence = sequences.find((sequence) =>
      sequence.aliasTokens.every((token, offset) => tokens[index + offset] === token)
    );

    if (matchedSequence) {
      normalizedTokens.push(...matchedSequence.canonicalTokens);
      index += matchedSequence.aliasTokens.length;
      continue;
    }

    normalizedTokens.push(tokens[index] ?? "");
    index += 1;
  }

  return normalizedTokens
    .filter((token, index) => token && token !== normalizedTokens[index - 1])
    .join(" ")
    .trim();
}

function detectPlatformLabel(text: string): string {
  const normalizedText = normalizeAliasSequences(text, PLATFORM_ALIAS_SEQUENCES);
  const matchedRule = PLATFORM_NORMALIZATION_RULES.find((rule) =>
    normalizedText.includes(rule.canonical.toLowerCase())
  );

  return matchedRule?.label ?? "";
}

function normalizeRecommendationPromptText(userText: string): string {
  const trimmed = userText.trim();
  if (!isRecommendationRequest(trimmed)) {
    return trimmed;
  }

  const correctedTokens = trimmed.replace(/[A-Za-z0-9+]+/g, (token) => {
    const normalizedToken = token.toLowerCase();
    if (
      /\d/.test(normalizedToken) ||
      normalizedToken.length < 4 ||
      NORMALIZATION_SKIP_TOKENS.has(normalizedToken) ||
      PLATFORM_TOKEN_CANDIDATES.includes(normalizedToken)
    ) {
      return normalizedToken;
    }

    let bestCandidate = normalizedToken;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of PLATFORM_TOKEN_CANDIDATES) {
      if (Math.abs(candidate.length - normalizedToken.length) > 2) {
        continue;
      }

      const distance = levenshteinDistance(normalizedToken, candidate);
      if (distance < bestDistance) {
        bestCandidate = candidate;
        bestDistance = distance;
      }
    }

    if (
      bestDistance <= 1 ||
      (normalizedToken.length >= 5 &&
        bestDistance === 2 &&
        bestCandidate.startsWith(normalizedToken.slice(0, 2)))
    ) {
      return bestCandidate;
    }

    return normalizedToken;
  });

  return normalizeAliasSequences(correctedTokens, PLATFORM_ALIAS_SEQUENCES);
}

function isRetryRequest(userText: string): boolean {
  const normalized = userText.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return /^(?:please\s+)?(?:try|do|answer|send)?\s*again(?:\s+please)?$/.test(normalized) ||
    /^(?:please\s+)?retry(?:\s+that)?(?:\s+please)?$/.test(normalized) ||
    /^(?:same|once more|one more time)$/.test(normalized);
}

function resolvePromptText(
  messageStore: MessageStore,
  chatId: string,
  currentIncomingId: number,
  userText: string,
): string {
  const normalized = userText.trim();
  if (!isRetryRequest(normalized)) {
    return normalizeRecommendationPromptText(normalized);
  }

  const recentMessages = listRecentProcessedMessages(
    messageStore,
    chatId,
    currentIncomingId,
  );

  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    const message = recentMessages[index];
    if (message?.direction !== "incoming") {
      continue;
    }

    const candidate = message.text.trim();
    if (!candidate || isRetryRequest(candidate)) {
      continue;
    }

    return normalizeRecommendationPromptText(candidate);
  }

  return normalizeRecommendationPromptText(normalized);
}

function hasExplicitScopeSplit(userText: string): boolean {
  const normalized = userText.trim().toLowerCase();
  return /\b(language|languages|genre|genres|platform|platforms|regional|region|only|just|specifically)\b/.test(
    normalized,
  ) || LANGUAGE_NAMES.some((language) => normalized.includes(language));
}

function isBroadRecommendationScope(userText: string): boolean {
  return isRecommendationRequest(userText) && !hasExplicitScopeSplit(userText);
}

function normalizeHeaderText(line: string): string {
  return line
    .replace(/\*/g, "")
    .replace(/[`_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isLanguageSublistHeader(line: string): boolean {
  const normalized = normalizeHeaderText(line);
  return LANGUAGE_NAMES.some((language) =>
    new RegExp(`^${language}\\s+(highlight|highlights|pick|picks|shows|show|series|spotlight):?$`, "i").test(
      normalized,
    )
    || new RegExp(`^${language}:$`, "i").test(normalized),
  );
}

function isScopeNarrowingClose(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  return (
    /\bif you want\b/.test(normalized) ||
    /\bif you say\b/.test(normalized)
  ) && /\b(language|languages|genre|genres|platform|platforms|regional|region)\b/.test(normalized);
}

function sanitizeRecommendationReplyScope(
  userText: string,
  replyText: string,
): string {
  if (!isBroadRecommendationScope(userText)) {
    return replyText;
  }

  const introSanitized = replyText.replace(
    /\((?:incl\.?|including)\s+[^)]*\b(?:hindi|english|malayalam|tamil|telugu|kannada|bengali|marathi|punjabi|gujarati|odia|assamese)\b[^)]*\)/gi,
    "",
  );

  const lines = introSanitized.split(/\r?\n/);
  const sanitizedLines: string[] = [];
  let skippingLanguageSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (isLanguageSublistHeader(trimmed)) {
      skippingLanguageSection = true;
      continue;
    }

    if (skippingLanguageSection) {
      if (!trimmed) {
        skippingLanguageSection = false;
      }
      continue;
    }

    if (isScopeNarrowingClose(trimmed)) {
      continue;
    }

    sanitizedLines.push(line);
  }

  return sanitizedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function summarizeMessagesForLog(messages: LlmMessage[]): Array<{
  role: string;
  content: string;
}> {
  return messages.map((message) => ({
    role: message.role,
    content: redactForLog(message.content),
  }));
}

function limitTelegramText(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return "I could not generate a reply this time.";
  }

  if (normalized.length <= 4000) {
    return normalized;
  }

  return `${normalized.slice(0, 3997)}...`;
}

function sanitizeTelegramReplyText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi, "$1")
    .replace(/https?:\/\/\S+/gi, (url) => url.replace(/[?&]utm_source=openai\b/gi, ""))
    .replace(/\(\s*[a-z0-9.-]+\.(?:com|org|net|io|co|tv)\s*\)/gi, "")
    .replace(/(^|\n)#{1,6}\s*/g, "$1")
    .replace(/\s#{1,6}\s+/g, " ")
    .replace(/[*_`]+/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeStructuredTelegramReplyText(text: string): string {
  const lineStartNumberedItemCount = (text.match(/(?:^|\n)\d+[.)]\s+/g) ?? []).length;
  const inlineNumberedItemCount = (text.match(/(?:^|\n|\s)\d+[.)]\s+/g) ?? []).length;

  if (lineStartNumberedItemCount >= 2 || inlineNumberedItemCount < 2) {
    return text
      .replace(/([)\].?!])\s+(?=(?:For|If|Also|Then|Next)\b)/g, "$1\n")
      .trim();
  }

  return text
    .replace(/\s+(?=\d+[.)]\s+)/g, "\n")
    .replace(/([)\].?!])\s+(?=(?:For|If|Also|Then|Next)\b)/g, "$1\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const slice = text.slice(0, Math.max(0, maxChars - 3)).trimEnd();
  const lastWhitespace = slice.lastIndexOf(" ");
  const compact = lastWhitespace >= Math.floor(maxChars * 0.6)
    ? slice.slice(0, lastWhitespace).trimEnd()
    : slice;

  return `${compact}...`;
}

function isStructuredTelegramReply(text: string): boolean {
  const numberedItemCount = (text.match(/(?:^|\n)\d+[.)]\s+/g) ?? []).length;
  const bulletItemCount = (text.match(/(?:^|\n)[-*]\s+/g) ?? []).length;
  return numberedItemCount >= 1 || bulletItemCount >= 2;
}

function splitReplySentences(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9("'`])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function trimVerboseSections(userText: string, replyText: string): string {
  let compact = replyText
    .replace(/\bSources?\s*:[\s\S]*$/i, "")
    .trim();

  if (/\bweather\b/i.test(userText)) {
    compact = compact
      .replace(/\bWeather for [^:]+:\s*/gi, "")
      .replace(/\bCurrent Conditions:\s*/gi, "")
      .replace(/\b(?:Daily|Weekly|Extended)\s+Forecast\s*:[\s\S]*$/i, "")
      .replace(/\bForecast\s*:[\s\S]*$/i, "")
      .trim();
  }

  return compact
    .replace(/[^\S\r\n]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function makeTelegramReplyConcise(userText: string, replyText: string): string {
  const compact = trimVerboseSections(userText, replyText);
  if (!compact || isStructuredTelegramReply(compact)) {
    return compact || replyText.trim();
  }

  const sentenceCount = splitReplySentences(compact).length;
  const hasVerboseMarkers = /\b(?:Daily|Weekly|Extended)\s+Forecast\b|Current Conditions:|Sources?\s*:|#{1,6}\s+/i.test(replyText);
  if (compact.length <= 220 && sentenceCount <= 3 && !hasVerboseMarkers) {
    return compact;
  }

  const sentences = splitReplySentences(compact);
  if (sentences.length === 0) {
    return truncateAtWordBoundary(compact, 320);
  }

  if (/\bweather\b/i.test(userText)) {
    return truncateAtWordBoundary(sentences[0] ?? compact, 220);
  }

  return truncateAtWordBoundary(sentences.slice(0, 2).join(" "), 320);
}

function detectRequestedListLimit(userText: string): number {
  const match = userText.match(/\b([1-9]|10)\b/);
  if (!match) {
    return 10;
  }

  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(parsed) ? Math.max(2, Math.min(parsed, 10)) : 10;
}

function isCompoundUserRequest(userText: string): boolean {
  const normalized = userText.trim().toLowerCase();
  const actionMatches = normalized.match(
    /\b(suggest|recommend|tell|show|give|list|compare|explain|summarize|pick|find)\b/g,
  ) ?? [];

  return actionMatches.length >= 2 ||
    /\b(and then|then|also|plus|as well as|after that)\b/.test(normalized);
}

function extractCompactRecommendationItems(replyText: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  const normalized = replyText
    .replace(/\r\n/g, "\n")
    .replace(/\s+-\s+(?=["“])/g, "\n");
  const rawLines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const rawLine of rawLines) {
    let line = rawLine
      .replace(/^here are[^:]*:\s*/i, "")
      .replace(/^\d+\.\s*/, "")
      .replace(/^[-*]\s*/, "")
      .replace(/\([^)]+\.(?:com|org|net|io|co|tv)[^)]*\)/gi, "")
      .trim();

    if (!line || /^these\b/i.test(line) || /^source/i.test(line)) {
      continue;
    }

    const titleWithYear = line.match(/[“"]?([^"”]+?)[”"]?\s*\(((?:19|20)\d{2})\)/);
    if (titleWithYear) {
      line = `${titleWithYear[1]?.trim() ?? ""} (${titleWithYear[2]})`;
    } else {
      line = line.split(/\s+[—-]\s+/)[0]?.trim() ?? line;
    }

    line = line
      .replace(/^[“"]+/, "")
      .replace(/[”"]+$/, "")
      .replace(/[.:;,]+$/, "")
      .trim();

    if (!line || line.length < 2 || line.length > 120) {
      continue;
    }

    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    items.push(line);
  }

  return items;
}

type RecommendationEntry = {
  title: string;
  note: string;
};

function normalizeRecommendationText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\u00A0/g, " ");
}

function stripRecommendationFormatting(text: string): string {
  return text
    .replace(/\([^)]+\.(?:com|org|net|io|co|tv)[^)]*\)/gi, "")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function trimRecommendationNote(note: string): string {
  const normalized = stripRecommendationFormatting(note)
    .replace(/[.?!]\s+(?:these|this|together|overall|collectively)\b[\s\S]*$/i, "")
    .replace(/[.?!]+$/, "");

  if (!normalized) {
    return "";
  }

  const words = normalized.split(/\s+/);
  if (words.length <= 20) {
    return normalized;
  }

  return `${words.slice(0, 20).join(" ").trim()}...`;
}

function parseRecommendationEntry(rawLine: string): RecommendationEntry | null {
  const cleaned = stripRecommendationFormatting(
    rawLine
      .replace(/^\d+[.)]\s*/, "")
      .replace(/^[-*]\s*/, "")
      .trim(),
  );

  if (!cleaned || /^here(?:'s| are)\b/i.test(cleaned) || /^based on\b/i.test(cleaned)) {
    return null;
  }

  let title = "";
  let note = "";
  const titleWithYear = cleaned.match(
    /^["']?(?<title>[^"']+?)["']?\s*\((?<year>(?:19|20)\d{2})\)\s*(?:[:\-–—]\s*(?<note>.+))?$/,
  );
  if (titleWithYear) {
    title = `${titleWithYear.groups?.title?.trim() ?? ""} (${titleWithYear.groups?.year ?? ""})`;
    note = trimRecommendationNote(titleWithYear.groups?.note ?? "");
  } else {
    const parts = cleaned.split(/\s+[-–—]\s+/);
    title = parts[0]?.trim() ?? cleaned;
    note = trimRecommendationNote(parts.slice(1).join(" - "));
  }

  title = title
    .replace(/^["']+/, "")
    .replace(/["']+$/, "")
    .replace(/[.:;,]+$/, "")
    .trim();

  if (!title || title.length < 2 || title.length > 120) {
    return null;
  }

  return { title, note };
}

function buildRecommendationHeader(userText: string): string {
  const normalized = userText.trim().toLowerCase();
  const kind = /\b(tv show|tv shows|show|shows|series|drama|dramas)\b/.test(normalized)
    ? "shows"
    : /\b(song|songs)\b/.test(normalized)
      ? "songs"
      : /\b(movie|movies|film|films)\b/.test(normalized)
        ? "movies"
        : "picks";
  const year = userText.match(/\b(19|20)\d{2}\b/)?.[0] ?? "";
  const platform = detectPlatformLabel(userText);

  const parts = ["Shortlist"];
  if (platform) {
    parts.push(`of ${platform}`);
  } else if (kind !== "picks") {
    parts.push("of");
  }
  if (kind !== "picks") {
    parts.push(kind);
  }
  if (year) {
    parts.push(`from ${year}`);
  }

  return `${parts.join(" ")}:`;
}

function extractYearBasedReadableItems(replyText: string): RecommendationEntry[] {
  const cleaned = normalizeRecommendationText(replyText)
    .replace(/^Here are[^:]*:\s*/i, "")
    .replace(/\s+-\s+(?=["'])/g, "\n")
    .replace(/\s+/g, " ")
    .trim();

  const pattern = /["']?(?<title>[^"':\n]+?)["']?\s*\((?<year>(?:19|20)\d{2})\)\s*[:\-]?\s*(?<note>.*?)(?=(?:\s+["']?[^"':\n]+?["']?\s*\((?:19|20)\d{2}\)\s*[:\-])|$)/g;
  const seen = new Set<string>();
  const items: RecommendationEntry[] = [];

  for (const match of cleaned.matchAll(pattern)) {
    const title = match.groups?.title?.trim().replace(/[.:;,]+$/, "") ?? "";
    const year = match.groups?.year?.trim() ?? "";
    const note = trimRecommendationNote(match.groups?.note ?? "");
    if (!title || !year) {
      continue;
    }

    const finalTitle = `${title} (${year})`;
    const key = finalTitle.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    items.push({ title: finalTitle, note });
  }

  return items;
}

function extractLineBasedReadableItems(replyText: string): RecommendationEntry[] {
  const seen = new Set<string>();
  const items: RecommendationEntry[] = [];
  const normalized = normalizeRecommendationText(replyText)
    .replace(/\s+(?=\d+[.)]\s+)/g, "\n")
    .replace(/\s+-\s+(?=["'])/g, "\n");
  const rawLines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const rawLine of rawLines) {
    if (/^these\b/i.test(rawLine) || /^source/i.test(rawLine)) {
      continue;
    }

    const entry = parseRecommendationEntry(
      rawLine.replace(/^here are[^:]*:\s*/i, ""),
    );
    if (!entry) {
      continue;
    }

    const key = entry.title.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    items.push(entry);
  }

  return items;
}

function extractNumberedReadableItems(replyText: string): RecommendationEntry[] {
  const seen = new Set<string>();
  const items: RecommendationEntry[] = [];
  const normalized = normalizeRecommendationText(replyText)
    .replace(/\s+(?=\d+[.)]\s+)/g, "\n");

  for (const match of normalized.matchAll(/(?:^|\n)\s*(\d+[.)]\s.*?)(?=(?:\n\s*\d+[.)]\s)|$)/gs)) {
    const segment = match[1]?.trim() ?? "";
    const entry = parseRecommendationEntry(segment);
    if (!entry) {
      continue;
    }

    const key = entry.title.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    items.push(entry);
  }

  return items;
}

function extractReadableRecommendationItems(replyText: string): RecommendationEntry[] {
  const numberedLineCount = (replyText.match(/(?:^|\n|\s)\d+[.)]\s+/g) ?? []).length;
  if (numberedLineCount >= 2) {
    return extractNumberedReadableItems(replyText);
  }

  const yearBasedItems = extractYearBasedReadableItems(replyText);
  if (yearBasedItems.length >= 2) {
    return yearBasedItems;
  }

  return extractLineBasedReadableItems(replyText);
}

function buildCompactRecommendationReply(
  userText: string,
  replyText: string,
): string {
  if (!isRecommendationRequest(userText) || isCompoundUserRequest(userText)) {
    return replyText;
  }

  const items = extractReadableRecommendationItems(replyText);
  if (items.length < 2) {
    return replyText;
  }

  const formattedItems = items
    .slice(0, detectRequestedListLimit(userText))
    .map((item, index) =>
      item.note
        ? `${index + 1}) ${item.title} - ${item.note}`
        : `${index + 1}) ${item.title}`
    )
    .join("\n");

  return `${buildRecommendationHeader(userText)}\n\n${formattedItems}`;
}

function buildTelegramReadyReply(userText: string, replyText: string): string {
  return limitTelegramText(
    makeTelegramReplyConcise(
      userText,
      normalizeStructuredTelegramReplyText(
        sanitizeTelegramReplyText(
          buildCompactRecommendationReply(userText, replyText),
        ),
      ),
    ),
  );
}

function expectsStructuredLiveList(userText: string): boolean {
  const normalized = userText.trim().toLowerCase();
  return isRecommendationRequest(userText) ||
    /\b(imdb|rating|ratings|rank|ranked|ranking|chart|charts|shortlist|list)\b/.test(normalized);
}

function getMinimumStructuredLiveItems(userText: string): number {
  if (!expectsStructuredLiveList(userText)) {
    return 0;
  }

  return Math.min(2, detectRequestedListLimit(userText));
}

function hasSufficientStructuredLiveItems(userText: string, replyText: string): boolean {
  const minimumItems = getMinimumStructuredLiveItems(userText);
  if (minimumItems < 2) {
    return true;
  }

  return extractReadableRecommendationItems(replyText).length >= minimumItems;
}

function extractRequestedSourceReference(userText: string): string {
  const match = userText
    .trim()
    .toLowerCase()
    .match(/\b(?:based on|according to|as per|per)\s+([a-z0-9+][a-z0-9+ .&-]{1,40})/i);
  if (!match?.[1]) {
    return "";
  }

  const source = match[1]
    .replace(/\b(?:genre|genres|year|years|list|lists|ranking|rankings|top|best)\b.*$/i, "")
    .replace(/[.?!,;:]+$/, "")
    .trim();
  const tokenCount = source.split(/\s+/).filter(Boolean).length;

  return tokenCount >= 1 && tokenCount <= 4 ? source : "";
}

function buildStructuredLiveRetryRequestText(
    requestText: string,
    minimumItems: number,
): string {
  const sourceReference = extractRequestedSourceReference(requestText);
  const extraInstructions = sourceReference
    ? `Prefer current results from ${sourceReference}, or reputable current sources that clearly cite ${sourceReference} if direct access is thin.`
    : "If the user named a source or ranking system, use current reputable sources that clearly cite it when direct access is thin.";

  return [
    requestText,
    "",
    `Return a verified numbered list with at least ${minimumItems} items if possible.`,
    "Use one item per line and keep each note brief.",
    extraInstructions,
  ].join("\n");
}

function buildFallbackReply(userText: string, plan: ReplyPlan): string {
  const normalized = userText.trim().toLowerCase();

  if (plan.mentionLimits) {
    if (isRecommendationRequest(normalized)) {
      return "I could not verify a fresh list right now, but I can still give likely picks if you tell me the year, language, or genre you want.";
    }

    return "I cannot access live or external data in this build yet, but I can still help with a general answer or next best step.";
  }

  if (plan.intent === "clarify") {
    return "I need a bit more detail to answer well. Tell me what outcome you want, and I will keep it concise.";
  }

  if (plan.intent === "brainstorm") {
    return "I could not finish the full AI-generated list this time, but I can still brainstorm options if you tell me your preferences.";
  }

  if (isRecommendationRequest(normalized)) {
    return "I could not finish the recommendation list this time. Tell me your preferred year, language, or genre, and I will suggest a short shortlist.";
  }

  return "I could not generate a complete reply this time. Please try again.";
}

function buildProcessingFailureReply(error: unknown): string {
  if (error instanceof TelegramDeliveryError) {
    return "Sorry, I had trouble delivering the reply. Please try again.";
  }

  return "Sorry, I hit an AI error while replying. Please try again.";
}

function getResponseMaxOutputTokens(config: AppConfig): number {
  if (/^gpt-5/i.test(config.llm.model)) {
    return Math.max(config.llm.maxResponseTokens, 1000);
  }

  return config.llm.maxResponseTokens;
}

function getResponseTimeoutMs(config: AppConfig): number {
  if (/^gpt-5/i.test(config.llm.model)) {
    return Math.max(config.llm.requestTimeoutMs, 30000);
  }

  return config.llm.requestTimeoutMs;
}

function shouldPreferNonStreamingResponse(
  config: AppConfig,
  userText: string,
  plan: ReplyPlan,
): boolean {
  return /^gpt-5/i.test(config.llm.model) &&
    plan.replyStyle === "structured";
}

async function resolveLiveLookupReply(
  logger: FastifyBaseLogger,
  liveLookupClient: LiveLookupClient | null,
  userText: string,
  conversationContext?: string,
): Promise<LiveLookupResolution> {
  const requiresVerifiedAnswer = requiresVerifiedLiveAnswer(
    userText,
    conversationContext,
  );
  if (!shouldUseLiveLookup(userText, conversationContext)) {
    return {
      replyText: null,
    };
  }

  const lookupRequestText = buildLiveLookupRequestText(
    userText,
    conversationContext,
  );

  if (!liveLookupClient) {
    if (requiresVerifiedAnswer) {
      return {
        replyText: buildVerifiedLiveFailureReply(),
        skipLlmFallback: true,
      };
    }

    return {
      replyText: null,
      fallbackContext: buildBestGuessFallbackContext(userText),
    };
  }

  try {
      const minimumStructuredItems = getMinimumStructuredLiveItems(userText);
      let lookupAttempts = 0;

      const runLookup = async (requestText: string) => {
        lookupAttempts += 1;
        const result = await liveLookupClient.lookup(requestText);
        const weakAnswer = result ? isWeakLiveLookupAnswer(result.answer) : false;
        const insufficientStructuredItems = result
          ? !hasSufficientStructuredLiveItems(userText, result.answer)
          : false;

        return {
          result,
          weakAnswer,
          insufficientStructuredItems,
          isUsable: Boolean(
            result &&
            !weakAnswer &&
            !insufficientStructuredItems,
          ),
        };
      };

      let lookupState = await runLookup(lookupRequestText);

      if (minimumStructuredItems >= 2 && !lookupState.isUsable) {
        lookupState = await runLookup(
          buildStructuredLiveRetryRequestText(
            lookupRequestText,
            minimumStructuredItems,
          ),
        );
      }

      const lookupResult = lookupState.result;
      const isUsableLiveAnswer = lookupState.isUsable;
      if (!lookupResult || !isUsableLiveAnswer) {
        if (requiresVerifiedAnswer) {
          logger.warn(
            {
              lookupModel: lookupResult?.model ?? null,
              sourceCount: lookupResult?.sources.length ?? 0,
              weakAnswer: lookupResult ? lookupState.weakAnswer : null,
              insufficientStructuredItems: lookupResult ? lookupState.insufficientStructuredItems : null,
              lookupAttempts,
            },
            "live lookup returned no verified answer",
          );

        return {
          replyText: buildVerifiedLiveFailureReply(),
          skipLlmFallback: true,
        };
      }

      return {
        replyText: null,
        fallbackContext: buildBestGuessFallbackContext(userText),
      };
    }
      logger.info(
        {
          lookupProvider: "openai_search",
          lookupModel: lookupResult.model,
          sourceCount: lookupResult.sources.length,
          lookupAttempts,
        },
        "completed live lookup",
      );

    return {
      replyText: lookupResult.answer,
    };
  } catch (error) {
    logger.warn(
      {
        err: error,
        requiresVerifiedAnswer,
      },
      requiresVerifiedAnswer
        ? "live lookup failed; returning a verified-data failure reply"
        : "live lookup failed; falling back to llm",
    );

    if (requiresVerifiedAnswer) {
      return {
        replyText: buildVerifiedLiveFailureReply(),
        skipLlmFallback: true,
      };
    }

    return {
      replyText: null,
      fallbackContext: buildBestGuessFallbackContext(userText),
    };
  }
}

async function recoverWithNonStreamingResponse(
  logger: FastifyBaseLogger,
  llmClient: LlmClient,
  responseMessages: LlmMessage[],
  maxOutputTokens: number,
  timeoutMs: number,
): Promise<string> {
  const generateResult = await llmClient.generate({
    messages: responseMessages,
    maxOutputTokens,
    timeoutMs,
  });

  logger.info(
    {
      llmPhase: "response-recovery",
      model: generateResult.model,
      prompts: summarizeMessagesForLog(responseMessages),
      completion: redactForLog(generateResult.text),
      maxOutputTokens,
    },
    "completed non-stream response recovery",
  );

  return generateResult.text;
}

async function processIncomingMessage({
  config,
  logger,
  llmClient,
  liveLookupClient,
  messageAdapter,
  messageStore,
  incomingMessage,
  incomingRecord,
}: BackgroundReplyOptions): Promise<void> {
  let outgoingRecord: MessageRecord | null = null;
  let outgoingMessageId: string | null = null;
  let latestPayloadJson: string | null = null;
  let latestTimestamp = currentTimestamp();

  const failProcessing = async (error: unknown) => {
    const failureReplyText = buildProcessingFailureReply(error);

    updateMessageSafely(
      logger,
      messageStore,
      incomingRecord.id,
      { status: "failed" },
      {
        adapter: incomingMessage.platform,
        direction: "incoming",
        chatId: incomingMessage.chatId,
      },
    );

    if (outgoingRecord) {
      let failureText = outgoingRecord.text;

      if (outgoingMessageId) {
        try {
          const failedDelivery = await messageAdapter.editMessage({
            chatId: incomingMessage.chatId,
            messageId: outgoingMessageId,
            text: failureReplyText,
          });
          latestPayloadJson = failedDelivery.payloadJson;
          latestTimestamp = failedDelivery.timestamp;
          failureText = failureReplyText;
        } catch (editError) {
          logger.warn(
            {
              err: editError,
              adapter: incomingMessage.platform,
              chatId: incomingMessage.chatId,
              outgoingId: outgoingRecord.id,
            },
            "failed to update telegram message after llm error",
          );
        }
      }

      updateMessageSafely(
        logger,
        messageStore,
        outgoingRecord.id,
        {
          status: "failed",
          text: failureText,
          telegramMessageId: parseStoredMessageId(outgoingMessageId),
          messageTimestamp: latestTimestamp,
          payloadJson: latestPayloadJson ?? serializeErrorPayload(error),
        },
        {
          adapter: incomingMessage.platform,
          direction: "outgoing",
          chatId: incomingMessage.chatId,
        },
      );
    }

    logger.error(
      {
        err: error,
        adapter: incomingMessage.platform,
        chatId: incomingMessage.chatId,
        incomingId: incomingRecord.id,
        outgoingId: outgoingRecord?.id ?? null,
      },
      "background reply processing failed",
    );
  };

  try {
    outgoingRecord = insertMessageOrThrow(
      logger,
      messageStore,
      {
        chatId: incomingMessage.chatId,
        userId: null,
        direction: "outgoing",
        status: "received",
        text: "Thinking...",
        messageTimestamp: currentTimestamp(),
        payloadJson: null,
      },
      {
        adapter: incomingMessage.platform,
        chatId: incomingMessage.chatId,
        direction: "outgoing",
        status: "received",
      },
    );

    try {
      const placeholderDelivery = await messageAdapter.sendMessage({
        chatId: incomingMessage.chatId,
        text: "Thinking...",
        replyToMessageId: incomingMessage.replyToMessageId,
      });

      outgoingMessageId = placeholderDelivery.messageId;
      latestPayloadJson = placeholderDelivery.payloadJson;
      latestTimestamp = placeholderDelivery.timestamp;

      updateMessageSafely(
        logger,
        messageStore,
        outgoingRecord.id,
        {
          telegramMessageId: parseStoredMessageId(outgoingMessageId),
          messageTimestamp: latestTimestamp,
          payloadJson: latestPayloadJson,
        },
        {
          adapter: incomingMessage.platform,
          direction: "outgoing",
          chatId: incomingMessage.chatId,
        },
      );
    } catch (error) {
      latestPayloadJson = serializeErrorPayload(error);
      latestTimestamp = currentTimestamp();
      logger.warn(
        {
          err: error,
          adapter: incomingMessage.platform,
          chatId: incomingMessage.chatId,
          outgoingId: outgoingRecord.id,
        },
        "failed to send placeholder message; continuing without placeholder",
      );
      updateMessageSafely(
        logger,
        messageStore,
        outgoingRecord.id,
        {
          messageTimestamp: latestTimestamp,
          payloadJson: latestPayloadJson,
        },
        {
          adapter: incomingMessage.platform,
          direction: "outgoing",
          chatId: incomingMessage.chatId,
        },
      );
    }

    const promptText = truncateForPrompt(
      resolvePromptText(
        messageStore,
        incomingMessage.chatId,
        incomingRecord.id,
        incomingMessage.text,
      ),
      config.llm.maxPromptChars,
    );
    const conversationContext = buildConversationContext(
      messageStore,
      incomingMessage.chatId,
      incomingRecord.id,
    );
    const liveLookup = await resolveLiveLookupReply(
      logger,
      liveLookupClient,
      promptText,
      conversationContext,
    );
    let lastSentText = "Thinking...";
    let lastEditAt = Date.now();

    const flushStream = async (force = false): Promise<boolean> => {
      if (!outgoingMessageId) {
        return false;
      }

      const nextText = limitTelegramText(
        streamedText.trim() || "Thinking...",
      );
      if (nextText === lastSentText) {
        return true;
      }

      if (!force && Date.now() - lastEditAt < config.llm.streamUpdateIntervalMs) {
        return true;
      }

      try {
        const editResult = await messageAdapter.editMessage({
          chatId: incomingMessage.chatId,
          messageId: outgoingMessageId,
          text: nextText,
        });
        lastEditAt = Date.now();
        lastSentText = nextText;
        latestPayloadJson = editResult.payloadJson;
        latestTimestamp = editResult.timestamp;
        return true;
      } catch (error) {
        latestPayloadJson = serializeErrorPayload(error);
        latestTimestamp = currentTimestamp();
        logger.warn(
          {
            err: error,
            adapter: incomingMessage.platform,
            chatId: incomingMessage.chatId,
            outgoingId: outgoingRecord?.id ?? null,
            force,
          },
          "failed to edit telegram reply; will fall back to sending the final message",
        );
        return false;
      }
    };
    let streamedText = "";
    let finalReplyText = "";

    if (liveLookup.replyText) {
      finalReplyText = buildTelegramReadyReply(promptText, liveLookup.replyText);
    } else if (liveLookup.skipLlmFallback) {
      finalReplyText = buildTelegramReadyReply(
        promptText,
        buildVerifiedLiveFailureReply(),
      );
    } else {
      const plannerResult = await createReplyPlan(
        llmClient,
        promptText,
        config.llm.plannerMaxResponseTokens,
        {
          conversationContext,
        },
      );

      logger.info(
        {
          llmPhase: "planner",
          model: config.llm.model,
          prompts: summarizeMessagesForLog(plannerResult.messages),
          completion: redactForLog(plannerResult.rawText),
          plan: plannerResult.plan,
          liveLookupFallback: liveLookup.fallbackContext ?? null,
          conversationContext: conversationContext
            ? redactForLog(conversationContext)
            : null,
        },
        "completed planner prompt",
      );

      const responseMessages = buildResponseMessages(
        promptText,
        plannerResult.plan,
        {
          supplementalContext: liveLookup.fallbackContext,
          conversationContext,
        },
      );
      const responseMaxOutputTokens = getResponseMaxOutputTokens(config);
      const responseTimeoutMs = getResponseTimeoutMs(config);
      const preferNonStreamingResponse = shouldPreferNonStreamingResponse(
        config,
        promptText,
        plannerResult.plan,
      );
      logger.info(
        {
          llmPhase: "response",
          model: config.llm.model,
          prompts: summarizeMessagesForLog(responseMessages),
          maxOutputTokens: responseMaxOutputTokens,
          timeoutMs: responseTimeoutMs,
          preferNonStreamingResponse,
        },
        preferNonStreamingResponse
          ? "starting non-stream response"
          : "starting response stream",
      );

      if (preferNonStreamingResponse) {
        streamedText = await recoverWithNonStreamingResponse(
          logger,
          llmClient,
          responseMessages,
          responseMaxOutputTokens,
          responseTimeoutMs,
        );
      } else {
        for await (const event of llmClient.stream({
          messages: responseMessages,
          maxOutputTokens: responseMaxOutputTokens,
          timeoutMs: responseTimeoutMs,
        })) {
          if (event.type === "text-delta") {
            streamedText += event.delta;
            await flushStream(false);
            continue;
          }

          if (
            event.type === "completed" &&
            event.text.trim().length > streamedText.trim().length
          ) {
            streamedText = event.text;
          }
        }
      }

      if (!streamedText.trim()) {
        streamedText = await recoverWithNonStreamingResponse(
          logger,
          llmClient,
          responseMessages,
          responseMaxOutputTokens,
          responseTimeoutMs,
        );
      }

      finalReplyText = buildTelegramReadyReply(
        promptText,
        sanitizeRecommendationReplyScope(
          promptText,
          streamedText || buildFallbackReply(promptText, plannerResult.plan),
        ),
      );
    }

    if (outgoingMessageId) {
      streamedText = finalReplyText;
      const editedFinalReply = await flushStream(true);
      if (!editedFinalReply) {
        const finalDelivery = await messageAdapter.sendMessage({
          chatId: incomingMessage.chatId,
          text: finalReplyText,
          replyToMessageId: incomingMessage.replyToMessageId,
        });
        outgoingMessageId = finalDelivery.messageId;
        latestPayloadJson = finalDelivery.payloadJson;
        latestTimestamp = finalDelivery.timestamp;
      }
    } else {
      const finalDelivery = await messageAdapter.sendMessage({
        chatId: incomingMessage.chatId,
        text: finalReplyText,
        replyToMessageId: incomingMessage.replyToMessageId,
      });
      outgoingMessageId = finalDelivery.messageId;
      latestPayloadJson = finalDelivery.payloadJson;
      latestTimestamp = finalDelivery.timestamp;
    }

    updateMessageSafely(
      logger,
      messageStore,
      incomingRecord.id,
      { status: "processed" },
      {
        adapter: incomingMessage.platform,
        direction: "incoming",
        chatId: incomingMessage.chatId,
      },
    );
    updateMessageSafely(
      logger,
      messageStore,
      outgoingRecord.id,
      {
        status: "processed",
        text: finalReplyText,
        telegramMessageId: parseStoredMessageId(outgoingMessageId),
        messageTimestamp: latestTimestamp,
        payloadJson: latestPayloadJson,
      },
      {
        adapter: incomingMessage.platform,
        direction: "outgoing",
        chatId: incomingMessage.chatId,
      },
    );

    logger.info(
      {
        llmPhase: "response",
        model: config.llm.model,
        completion: redactForLog(finalReplyText),
        adapter: incomingMessage.platform,
        chatId: incomingMessage.chatId,
        incomingId: incomingRecord.id,
        outgoingId: outgoingRecord.id,
      },
      "completed response stream",
    );
  } catch (error) {
    await failProcessing(error);
  }
}

export function buildApp(
  config: AppConfig,
  options: BuildAppOptions = {},
): FastifyInstance {
  const ownsStore = !options.messageStore;
  const messageStore =
    options.messageStore ?? createMessageStore(config.database.path);
  const messageAdapter =
    options.messageAdapter ??
    new TelegramAdapter(
      options.telegramClient ??
        createTelegramClient(
          config.telegram.botToken,
          config.telegram.requestTimeoutMs,
        ),
    );
  const llmClient =
    options.llmClient ??
    createOpenAILlmClient({
      apiKey: config.llm.apiKey,
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      embeddingModel: config.llm.embeddingModel,
      requestTimeoutMs: config.llm.requestTimeoutMs,
    });
  const liveLookupClient =
    options.liveLookupClient ??
    createLiveLookupClient(config.liveLookup);
  const rateLimiter = createRateLimiter(
    config.telegram.rateLimitWindowMs,
    config.telegram.rateLimitMaxRequests,
  );

  const app = Fastify({
    logger: {
      level: config.logger.level,
    },
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof MessagePersistenceError) {
      request.log.error({ err: error }, "message persistence failed");
      reply.status(error.statusCode).send({ error: error.message });
      return;
    }

    if (error instanceof TelegramDeliveryError || error instanceof LlmRequestError) {
      request.log.warn(
        { err: error, statusCode: error.statusCode },
        "delivery or llm request failed",
      );
      reply.status(error.statusCode).send({ error: error.message });
      return;
    }

    request.log.error({ err: error }, "request failed");
    reply.status(500).send({ error: "Internal server error" });
  });

  app.addHook("onClose", async () => {
    if (ownsStore) {
      messageStore.close();
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    uptime: process.uptime(),
    timestamp: currentTimestamp(),
    telegramWebhookPath: config.telegram.webhookPath,
    llmProvider: config.llm.provider,
    llmModel: config.llm.model,
    liveLookupProvider: config.liveLookup.provider,
  }));

  app.post(
    config.telegram.webhookPath,
    async (request, reply) => {
      const headers = request.headers as Record<
        string,
        string | string[] | undefined
      >;
      if (!messageAdapter.verifyRequest(headers, config.telegram.webhookSecret)) {
        request.log.warn(
          { adapter: messageAdapter.name },
          "rejected webhook with invalid secret",
        );
        reply.status(401).send({ error: "Invalid Telegram webhook secret" });
        return;
      }

      const incomingMessage = messageAdapter.parseIncoming(request.body);
      if (!incomingMessage) {
        request.log.info(
          { adapter: messageAdapter.name },
          "ignored incoming update without a supported text payload",
        );
        reply.send({ ok: true, ignored: true });
        return;
      }

      request.log.info(
        {
          adapter: incomingMessage.platform,
          eventId: incomingMessage.eventId,
          chatId: incomingMessage.chatId,
          userId: incomingMessage.userId,
          externalMessageId: incomingMessage.messageId,
          messageTimestamp: incomingMessage.timestamp,
          status: "received",
          textLength: incomingMessage.text.length,
        },
        "received incoming message",
      );

      const rateLimit = rateLimiter.check(incomingMessage.rateLimitKey);
      if (!rateLimit.allowed) {
        request.log.warn(
          {
            adapter: incomingMessage.platform,
            eventId: incomingMessage.eventId,
            chatId: incomingMessage.chatId,
            userId: incomingMessage.userId,
            retryAfterSeconds: rateLimit.retryAfterSeconds,
          },
          "rate limited incoming message",
        );
        reply.header("retry-after", String(rateLimit.retryAfterSeconds));
        reply.status(429).send({ error: "Rate limit exceeded" });
        return;
      }

      const incomingRecord = insertMessageOrThrow(
        request.log,
        messageStore,
        {
          chatId: incomingMessage.chatId,
          userId: incomingMessage.userId,
          direction: "incoming",
          status: "received",
          text: incomingMessage.text,
          telegramMessageId: parseStoredMessageId(incomingMessage.messageId),
          messageTimestamp: incomingMessage.timestamp,
          payloadJson: incomingMessage.payloadJson,
        },
        {
          adapter: incomingMessage.platform,
          chatId: incomingMessage.chatId,
          userId: incomingMessage.userId,
          direction: "incoming",
          externalMessageId: incomingMessage.messageId,
        },
      );

      const backgroundLogger = request.log.child({
        adapter: incomingMessage.platform,
        chatId: incomingMessage.chatId,
        userId: incomingMessage.userId,
        incomingId: incomingRecord.id,
      });

      void processIncomingMessage({
        config,
        logger: backgroundLogger,
        llmClient,
        liveLookupClient,
        messageAdapter,
        messageStore,
        incomingMessage,
        incomingRecord,
      });

      reply.send({
        ok: true,
        accepted: true,
      });
    },
  );

  return app;
}
