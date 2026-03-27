import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBestGuessFallbackContext,
  buildLiveLookupRequestText,
  buildVerifiedLiveFailureReply,
  createLiveLookupClient,
  isWeakLiveLookupAnswer,
  requiresVerifiedLiveAnswer,
  shouldUseLiveLookup,
} from "../src/live-lookup.js";

test("shouldUseLiveLookup detects year-specific recommendation requests", () => {
  assert.equal(
    shouldUseLiveLookup("suggest me good 5 movies to watch from english released in 2025"),
    true,
  );
  assert.equal(
    shouldUseLiveLookup("best songs from 2021 english"),
    true,
  );
  assert.equal(
    shouldUseLiveLookup(
      "i want only from 2025",
      "User: best telugu songs of 2025\nAssistant: Here are a few likely picks.",
    ),
    true,
  );
  assert.equal(
    shouldUseLiveLookup("what is the latest news in india"),
    true,
  );
  assert.equal(
    shouldUseLiveLookup("top 5 shows based on imdb rating"),
    true,
  );
  assert.equal(
    shouldUseLiveLookup("tell me the weather of chennai now"),
    true,
  );
  assert.equal(
    shouldUseLiveLookup("is sentimental value a norwegian movie ?"),
    true,
  );
  assert.equal(
    shouldUseLiveLookup(
      "then which language movie is this ?",
      "User: is sentimental value a norwegian movie ?\nAssistant: I don't recognize that title yet.",
    ),
    true,
  );
  assert.equal(
    shouldUseLiveLookup("write a birthday message for my friend"),
    false,
  );
});

test("buildBestGuessFallbackContext makes the fallback mode explicit", () => {
  const context = buildBestGuessFallbackContext("best telugu movies in 2025");

  assert.match(context, /No verified live lookup data was available/i);
  assert.match(context, /likely picks/i);
  assert.match(context, /best telugu movies in 2025/i);
});

test("requiresVerifiedLiveAnswer marks only real-time fact prompts as fail-closed", () => {
  assert.equal(requiresVerifiedLiveAnswer("tell me the weather of chennai now"), true);
  assert.equal(requiresVerifiedLiveAnswer("top 5 shows based on imdb rating"), false);
  assert.equal(requiresVerifiedLiveAnswer("best telugu songs of 2025"), false);
  assert.equal(requiresVerifiedLiveAnswer("best songs from 2021 english"), false);
  assert.equal(requiresVerifiedLiveAnswer("best places to visit in rajasthan in 2026"), false);
  assert.equal(requiresVerifiedLiveAnswer("best ai courses to learn in 2026"), false);
  assert.equal(requiresVerifiedLiveAnswer("current top 5 shows based on imdb rating"), false);
  assert.equal(
    requiresVerifiedLiveAnswer(
      "i want only from 2025",
      "User: best telugu songs of 2025\nAssistant: Here are a few likely picks.",
    ),
    false,
  );
  assert.equal(requiresVerifiedLiveAnswer("best feel-good movies to watch"), false);
});

test("buildVerifiedLiveFailureReply stays concise and avoids external-site suggestions", () => {
  const reply = buildVerifiedLiveFailureReply();

  assert.match(reply, /won't guess/i);
  assert.doesNotMatch(reply, /google|weather\.com|accuweather/i);
});

test("isWeakLiveLookupAnswer rejects hedgey live-data responses", () => {
  assert.equal(isWeakLiveLookupAnswer("I can't see live weather data right now."), true);
  assert.equal(isWeakLiveLookupAnswer("Check Google for Chennai weather now."), true);
  assert.equal(isWeakLiveLookupAnswer("Chennai is 31C with light rain and 78% humidity."), false);
});

test("buildLiveLookupRequestText includes recent conversation for referential follow-ups", () => {
  const requestText = buildLiveLookupRequestText(
    "i want only from 2025",
    "User: best telugu songs of 2025\nAssistant: Here are a few likely picks.",
  );

  assert.match(requestText, /<recent_conversation>/);
  assert.match(requestText, /best telugu songs of 2025/i);
  assert.match(requestText, /<latest_user_request>/);
  assert.match(requestText, /i want only from 2025/i);
});

test("buildLiveLookupRequestText preserves exact digits for short numeric follow-ups", () => {
  const requestText = buildLiveLookupRequestText(
    "2000",
    "User: best restaurants in mumbai\nAssistant: What budget should I use?",
  );

  assert.match(requestText, /Preserve every digit exactly as written/i);
  assert.match(requestText, /\b2000\b/);
  assert.match(requestText, /<recent_conversation>/);
});

test("buildLiveLookupRequestText keeps movie-title context for short metadata follow-ups", () => {
  const requestText = buildLiveLookupRequestText(
    "then which language movie is this ?",
    [
      "User: is sentimental value a norwegian movie ?",
      "Assistant: I don't recognize that title yet.",
    ].join("\n"),
  );

  assert.match(requestText, /<recent_conversation>/);
  assert.match(requestText, /is sentimental value a norwegian movie \?/i);
  assert.match(requestText, /which language movie is this \?/i);
});

test("createLiveLookupClient parses a live lookup answer from OpenAI search output", async () => {
  const client = createLiveLookupClient(
    {
      provider: "openai_search",
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-search-preview",
      requestTimeoutMs: 5000,
      maxOutputTokens: 500,
    },
    async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              answer: "Here are 2 verified 2025 picks:\n1. Example One (2025)\n2. Example Two (2025)",
            }),
            annotations: [
              {
                type: "url_citation",
                title: "Example Source",
                url: "https://example.com",
              },
            ],
          },
        },
      ],
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    }),
  );

  const result = await client?.lookup("suggest me good 2 movies to watch from english released in 2025");

  assert.ok(result);
  assert.match(result?.answer ?? "", /verified 2025 picks/);
  assert.equal(result?.sources.length, 1);
  assert.equal(result?.model, "gpt-4o-mini-search-preview");
});
