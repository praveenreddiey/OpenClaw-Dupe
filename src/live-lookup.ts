import { getNumericRefinementInstruction } from "./request-shape.js";

export type LiveLookupConfig = {
  provider: "none" | "openai_search";
  apiKey: string;
  baseUrl: string;
  model: string;
  requestTimeoutMs: number;
  maxOutputTokens: number;
};

export type LiveLookupSource = {
  title: string;
  url: string;
};

export type LiveLookupResult = {
  answer: string;
  sources: LiveLookupSource[];
  rawText: string;
  model: string;
};

export type LiveLookupClient = {
  lookup(userText: string): Promise<LiveLookupResult | null>;
};

type FetchLike = typeof fetch;

type OpenAIChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{
        text?: string;
        content?: unknown;
        annotations?: OpenAIAnnotation[];
      }>;
      annotations?: OpenAIAnnotation[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type OpenAIAnnotation = {
  type?: string;
  title?: string;
  url?: string;
  url_citation?: {
    title?: string;
    url?: string;
  };
};

type ParsedLookupPayload = {
  answer: string;
  sources: LiveLookupSource[];
};

export class LiveLookupError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 502, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LiveLookupError";
    this.statusCode = statusCode;
  }
}

function buildUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${pathname}`;
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

function extractResponseText(payload: OpenAIChatCompletionResponse): string {
  const choice = payload.choices?.[0];
  return readTextContent(choice?.message?.content).trim();
}

function readAnnotations(content: unknown): OpenAIAnnotation[] {
  if (!content) {
    return [];
  }

  if (Array.isArray(content)) {
    return content.flatMap((part) => {
      if (part && typeof part === "object" && "annotations" in part && Array.isArray(part.annotations)) {
        return part.annotations as OpenAIAnnotation[];
      }

      return [];
    });
  }

  return [];
}

function extractSources(payload: OpenAIChatCompletionResponse): LiveLookupSource[] {
  const choice = payload.choices?.[0];
  const annotations = [
    ...(choice?.message?.annotations ?? []),
    ...readAnnotations(choice?.message?.content),
  ];
  const seen = new Set<string>();

  return annotations
    .map((annotation) => {
      const title = annotation.url_citation?.title ?? annotation.title ?? "";
      const url = annotation.url_citation?.url ?? annotation.url ?? "";
      if (!title || !url) {
        return null;
      }

      const key = `${title}::${url}`;
      if (seen.has(key)) {
        return null;
      }

      seen.add(key);
      return {
        title: title.trim(),
        url: url.trim(),
      };
    })
    .filter((source): source is LiveLookupSource => source !== null);
}

function parseLookupPayload(rawText: string): ParsedLookupPayload | null {
  const normalized = rawText.trim();
  if (!normalized) {
    return null;
  }

  try {
    const parsed = JSON.parse(normalized) as {
      answer?: unknown;
      sources?: unknown;
    };

    if (typeof parsed.answer !== "string" || !parsed.answer.trim()) {
      return null;
    }

    const sources = Array.isArray(parsed.sources)
      ? parsed.sources
        .map((source) => {
          if (!source || typeof source !== "object") {
            return null;
          }

          const title = "title" in source && typeof source.title === "string"
            ? source.title.trim()
            : "";
          const url = "url" in source && typeof source.url === "string"
            ? source.url.trim()
            : "";
          if (!title || !url) {
            return null;
          }

          return { title, url };
        })
        .filter((source): source is LiveLookupSource => source !== null)
      : [];

    return {
      answer: parsed.answer.trim(),
      sources,
    };
  } catch {
    return {
      answer: normalized,
      sources: [],
    };
  }
}

function truncateAnswer(answer: string, maxChars: number): string {
  const normalized = answer.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

const YEAR_PATTERN = /\b(19|20)\d{2}\b/;
const RECOMMENDATION_CUE_PATTERN = /\b(recommend|suggest|best|top|good|watch|listen|read|visit|try|buy|use)\b/;
const LIVE_CUE_PATTERN = /\b(today|latest|current|recent|released?|release|releases|news|weather|price|prices|score|scores|standings|calendar year|this year|now)\b/;
const RANKING_CUE_PATTERN = /\b(imdb|rating|ratings|rank|ranked|ranking|chart|charts|box office|trending)\b/;
const ENTITY_CUE_PATTERN = /\b(movie|movies|film|films|show|shows|series|song|songs|book|books|anime|restaurant|restaurants|place|places|app|apps|game|games|phone|phones|laptop|laptops|camera|cameras|course|courses|hotel|hotels|product|products)\b/;
const PLURAL_ENTITY_CUE_PATTERN = /\b(movies|films|shows|series|songs|books|restaurants|places|apps|games|phones|laptops|cameras|courses|hotels|products)\b/;
const SINGULAR_MEDIA_ENTITY_CUE_PATTERN = /\b(movie|film|show|series|song|book)\b/;
const EVERGREEN_DISCOVERY_ENTITY_CUE_PATTERN = /\b(place|places|destination|destinations|spot|spots|trail|trails|trek|treks|beach|beaches|fort|forts|museum|museums|park|parks|temple|temples|monument|monuments)\b/;
const TIME_BOUND_RELEASE_ENTITY_CUE_PATTERN = /\b(movie|movies|film|films|show|shows|series|song|songs|anime|game|games)\b/;
const STRICT_FILTER_CUE_PATTERN = /\b(exact|actual|verified|only|released?|release|calendar year|this year|according to)\b/;
const VERIFIED_LIVE_CUE_PATTERN = /\b(weather|news|latest|current|today|now|price|prices|score|scores|standings|imdb|rating|ratings|rank|ranked|ranking|chart|charts|box office|trending)\b/;
const STRICT_VERIFIED_LIVE_CUE_PATTERN = /\b(weather|news|price|prices|score|scores|standings)\b/;
const FOLLOW_UP_CONTEXT_CUE_PATTERN = /\b(only|just|same|that|this|those|these|released?|release|year|genre|language|platform)\b/;
const MEDIA_METADATA_QUESTION_CUE_PATTERN = /\b(is|was|what|which|who)\b/;
const MEDIA_METADATA_CUE_PATTERN = /\b(language|country|origin|director|directed|cast|actor|actress|release(?:d)?|year|platform|stream(?:ing)?|ott|norwegian|swedish|danish|french|german|spanish|italian|japanese|korean|chinese|hindi|telugu|tamil|malayalam|english)\b/;

function normalizeLookupText(text: string): string {
  return text.trim().toLowerCase();
}

function extractYears(normalizedText: string): number[] {
  return Array.from(normalizedText.matchAll(/\b(19|20)\d{2}\b/g))
    .map((match) => Number.parseInt(match[0], 10))
    .filter((year) => Number.isInteger(year));
}

function hasRecentOrFutureYear(normalizedText: string, now = new Date()): boolean {
  const currentYear = now.getUTCFullYear();
  return extractYears(normalizedText).some((year) => year >= currentYear - 1);
}

function isYearSpecificRecommendationRequest(normalizedText: string): boolean {
  return YEAR_PATTERN.test(normalizedText) &&
    RECOMMENDATION_CUE_PATTERN.test(normalizedText) &&
    ENTITY_CUE_PATTERN.test(normalizedText);
}

function hasStrongStandaloneLookupIntent(normalizedUserText: string): boolean {
  return VERIFIED_LIVE_CUE_PATTERN.test(normalizedUserText) ||
    (RECOMMENDATION_CUE_PATTERN.test(normalizedUserText) &&
      (ENTITY_CUE_PATTERN.test(normalizedUserText) || YEAR_PATTERN.test(normalizedUserText)));
}

function shouldBorrowConversationContext(normalizedUserText: string): boolean {
  if (!normalizedUserText || hasStrongStandaloneLookupIntent(normalizedUserText)) {
    return false;
  }

  const wordCount = normalizedUserText.split(/\s+/).filter(Boolean).length;
  return normalizedUserText.length <= 80 &&
    (wordCount <= 6 ||
      FOLLOW_UP_CONTEXT_CUE_PATTERN.test(normalizedUserText) ||
      YEAR_PATTERN.test(normalizedUserText));
}

function extractUserContext(conversationContext: string): string {
  const userLines = conversationContext
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^user:/i.test(line));

  return userLines.join("\n");
}

function buildLookupAnalysisText(
  userText: string,
  conversationContext?: string,
): string {
  const normalizedUserText = normalizeLookupText(userText);
  if (!normalizedUserText) {
    return "";
  }

  if (!conversationContext || !shouldBorrowConversationContext(normalizedUserText)) {
    return normalizedUserText;
  }

  const normalizedConversation = normalizeLookupText(
    extractUserContext(conversationContext),
  );
  return normalizedConversation
    ? `${normalizedConversation}\n${normalizedUserText}`
    : normalizedUserText;
}

function isStrictVerifiedRecommendationRequest(normalizedText: string): boolean {
  const hasYear = YEAR_PATTERN.test(normalizedText);
  const hasRecommendationCue = RECOMMENDATION_CUE_PATTERN.test(normalizedText);
  const hasEntityCue = ENTITY_CUE_PATTERN.test(normalizedText);
  const hasCatalogIntent = hasRecommendationCue ||
    RANKING_CUE_PATTERN.test(normalizedText) ||
    PLURAL_ENTITY_CUE_PATTERN.test(normalizedText);
  const hasLiveCue = LIVE_CUE_PATTERN.test(normalizedText);
  const hasRankingCue = RANKING_CUE_PATTERN.test(normalizedText);
  const hasStrictFilterCue = STRICT_FILTER_CUE_PATTERN.test(normalizedText);
  const hasRecentYear = hasRecentOrFutureYear(normalizedText);
  const isEvergreenDiscoveryAsk = EVERGREEN_DISCOVERY_ENTITY_CUE_PATTERN.test(normalizedText);
  const isTimeBoundReleaseAsk = TIME_BOUND_RELEASE_ENTITY_CUE_PATTERN.test(normalizedText);

  if (
    isEvergreenDiscoveryAsk &&
    !hasRankingCue &&
    !hasLiveCue &&
    !hasStrictFilterCue
  ) {
    return false;
  }

  return hasEntityCue &&
    hasCatalogIntent &&
    (
      hasLiveCue ||
      (hasRankingCue && (hasStrictFilterCue || hasRecentYear)) ||
      (isTimeBoundReleaseAsk && hasRecentYear && hasYear) ||
      (hasRecentYear && hasStrictFilterCue)
    );
}

function isMediaMetadataLookupRequest(normalizedText: string): boolean {
  return MEDIA_METADATA_QUESTION_CUE_PATTERN.test(normalizedText) &&
    MEDIA_METADATA_CUE_PATTERN.test(normalizedText) &&
    SINGULAR_MEDIA_ENTITY_CUE_PATTERN.test(normalizedText);
}

export function buildLiveLookupRequestText(
  userText: string,
  conversationContext?: string,
): string {
  const normalizedUserText = userText.trim();
  const numericRefinementInstruction = getNumericRefinementInstruction(userText);
  if (!normalizedUserText) {
    return normalizedUserText;
  }

  if (!conversationContext || !shouldBorrowConversationContext(normalizeLookupText(userText))) {
    return [
      numericRefinementInstruction,
      normalizedUserText,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    numericRefinementInstruction,
    "Use the recent conversation only to resolve references in the latest user request.",
    "<recent_conversation>",
    conversationContext.trim(),
    "</recent_conversation>",
    "<latest_user_request>",
    normalizedUserText,
    "</latest_user_request>",
  ].join("\n");
}

export function shouldUseLiveLookup(
  userText: string,
  conversationContext?: string,
): boolean {
  const normalized = buildLookupAnalysisText(userText, conversationContext);
  if (!normalized) {
    return false;
  }

  return VERIFIED_LIVE_CUE_PATTERN.test(normalized) ||
    isMediaMetadataLookupRequest(normalized) ||
    isStrictVerifiedRecommendationRequest(normalized) ||
    isYearSpecificRecommendationRequest(normalized);
}

export function buildBestGuessFallbackContext(userText: string): string {
  const normalized = userText.trim();
  if (!normalized) {
    return "No verified live lookup data was available.";
  }

  return `No verified live lookup data was available for this request. It is okay to use internal knowledge to give likely matches, but keep them clearly labeled as likely picks and stay as close as possible to the user's requested year or timeframe. Original request: ${normalized}`;
}

export function requiresVerifiedLiveAnswer(
  userText: string,
  conversationContext?: string,
): boolean {
  const normalized = buildLookupAnalysisText(userText, conversationContext);
  if (!normalized) {
    return false;
  }

  return STRICT_VERIFIED_LIVE_CUE_PATTERN.test(normalized);
}

export function buildVerifiedLiveFailureReply(): string {
  return "I couldn't retrieve verified live data right now, so I won't guess. Please try again in a moment.";
}

export function isWeakLiveLookupAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return [
    "can't access live",
    "cannot access live",
    "can't see live",
    "cannot see live",
    "can't verify",
    "cannot verify",
    "check google",
    "check any of these",
    "weather apps",
    "weather.com",
    "accuweather",
    "open google",
    "search \"",
    "search “",
  ].some((phrase) => normalized.includes(phrase));
}

export function createLiveLookupClient(
  config: LiveLookupConfig,
  fetchImpl: FetchLike = fetch,
): LiveLookupClient | null {
  if (config.provider === "none") {
    return null;
  }

  return {
    async lookup(userText) {
      if (!shouldUseLiveLookup(userText)) {
        return null;
      }

      const response = await fetchImpl(
        buildUrl(config.baseUrl, "/chat/completions"),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            web_search_options: {},
            max_completion_tokens: config.maxOutputTokens,
            messages: [
              {
                role: "system",
                content: [
                  "You are the Accurate Mode live lookup for a Telegram assistant.",
                  "Use live web search through this model to answer with up-to-date information.",
                  "Return a polished Telegram-ready reply with exact titles, names, and 4-digit years when relevant.",
                  "Prefer concise factual wording over filler.",
                    "For recommendation requests, default to a compact numbered list: one item per line, title first, followed by a brief informative note with one or two useful details.",
                  "If the user asks for multiple sub-requests in one message, answer each requested part explicitly in order and keep later parts instead of flattening everything into one list.",
                  "For recommendations or release-year requests, stay in the user's requested year or timeframe instead of switching to older substitute years.",
                  "Never guess supporting metadata such as song-to-film, show-to-platform, or title-to-year mappings.",
                  "If supporting metadata is uncertain, omit that metadata instead of inventing it.",
                  "Do not include markdown emphasis, markdown links, inline citations, or raw URLs in the answer body.",
                  "Do not suggest playlists, Google searches, or other places to check.",
                  "If the user names a source, ranking system, or reference point, prefer current results from it; if direct access is thin, use reputable current sources that clearly cite it.",
                  "For non-list answers, keep the reply to 1-2 short sentences unless the user explicitly asks for more detail.",
                  "For weather or other current-status questions, give the current result first and do not add multi-day forecasts or extended background unless asked.",
                  "If live results are thin, return the best verified shortlist you can and do not pad the list with low-confidence guesses.",
                  "Keep the answer concise and readable.",
                ].join(" "),
              },
              {
                role: "user",
                content: userText,
              },
            ],
          }),
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        },
      );

      const payloadText = await response.text();
      if (!response.ok) {
        throw new LiveLookupError(
          parseApiError(payloadText, "Live lookup request failed"),
          response.status,
        );
      }

      const payload = JSON.parse(payloadText) as OpenAIChatCompletionResponse;
      const rawText = extractResponseText(payload);
      const parsed = parseLookupPayload(rawText);
      if (!parsed) {
        return null;
      }

      return {
        answer: truncateAnswer(parsed.answer, 3500),
        sources: parsed.sources.length > 0 ? parsed.sources : extractSources(payload),
        rawText,
        model: config.model,
      };
    },
  };
}
