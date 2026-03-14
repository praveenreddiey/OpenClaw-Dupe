import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlannerMessages,
  buildResponseMessages,
  createReplyPlan,
  isRecommendationRequest,
} from "../src/planner.js";
import type { LlmClient } from "../src/llm.js";

test("buildPlannerMessages keeps system instructions separate from user input", () => {
  const messages = buildPlannerMessages("what is the weather today?", {
    conversationContext: "User: best tv shows in india\nAssistant: Which language do you want?",
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "user");
  assert.ok(messages[1]?.content.includes("what is the weather today?"));
  assert.ok(messages[1]?.content.includes("<recent_conversation>"));
  assert.ok(messages[1]?.content.includes("best tv shows in india"));
  assert.ok(!messages[0]?.content.includes("what is the weather today?"));
});

test("buildPlannerMessages preserves exact digits for short numeric follow-ups", () => {
  const messages = buildPlannerMessages("2000", {
    conversationContext: "User: best restaurants in mumbai\nAssistant: What budget should I use?",
  });

  assert.match(
    messages[1]?.content ?? "",
    /Preserve every digit exactly as written/i,
  );
  assert.match(messages[1]?.content ?? "", /\b2000\b/);
});

test("isRecommendationRequest recognizes broader catalog-style recommendation asks", () => {
  assert.equal(
    isRecommendationRequest("suggest me best korean dramas in thriller genre based on imdb"),
    true,
  );
  assert.equal(
    isRecommendationRequest("best ai courses to learn in 2026"),
    true,
  );
  assert.equal(
    isRecommendationRequest("best way to learn coding fast"),
    false,
  );
});

test("createReplyPlan falls back deterministically when the llm returns invalid json", async () => {
  const llmClient: LlmClient = {
    async generate() {
      return {
        model: "gpt-5-mini",
        text: "not-json",
      };
    },
    async *stream() {
      yield {
        type: "completed",
        text: "",
        model: "gpt-5-mini",
      };
    },
    async embeddings() {
      return {
        model: "text-embedding-3-small",
        vectors: [],
      };
    },
  };

  const result = await createReplyPlan(
    llmClient,
    "what is the weather today?",
    120,
  );

  assert.equal(result.plan.intent, "answer_question");
  assert.equal(result.plan.replyStyle, "concise");
  assert.equal(result.plan.mentionLimits, true);
});

test("createReplyPlan normalizes recommendation prompts into direct structured answers", async () => {
  const llmClient: LlmClient = {
    async generate() {
      return {
        model: "gpt-5-mini",
        text: JSON.stringify({
          intent: "brainstorm",
          objective: "Recommend movies",
          replyStyle: "concise",
          mentionLimits: false,
        }),
      };
    },
    async *stream() {
      yield {
        type: "completed",
        text: "",
        model: "gpt-5-mini",
      };
    },
    async embeddings() {
      return {
        model: "text-embedding-3-small",
        vectors: [],
      };
    },
  };

  const result = await createReplyPlan(
    llmClient,
    "suggest me best movies in telugu 2025",
    120,
  );

  assert.equal(result.plan.intent, "answer_question");
  assert.equal(result.plan.replyStyle, "structured");
  assert.equal(result.plan.mentionLimits, false);
});

test("buildResponseMessages injects the plan into system instructions and keeps user text separate", () => {
  const messages = buildResponseMessages("help me plan my day", {
    intent: "brainstorm",
    objective: "Offer a short day plan",
    replyStyle: "structured",
    mentionLimits: false,
  }, {
    supplementalContext: "No verified live lookup data was available for this request.",
  });

  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "user");
  assert.match(messages[0]?.content ?? "", /Offer a short day plan/);
  assert.match(messages[0]?.content ?? "", /internal knowledge to give a clearly labeled likely-picks shortlist/i);
  assert.match(messages[0]?.content ?? "", /Live lookup context:/);
  assert.match(messages[1]?.content ?? "", /help me plan my day/);
});

test("buildResponseMessages tells recommendation replies not to invent unrequested subcategories", () => {
  const messages = buildResponseMessages("best tv shows in india", {
    intent: "answer_question",
    objective: "Recommend TV shows in India",
    replyStyle: "structured",
    mentionLimits: false,
  });

  assert.match(messages[0]?.content ?? "", /Stay within the user's requested scope/i);
  assert.match(
    messages[0]?.content ?? "",
    /Do not introduce separate language, genre, platform, or regional sublists unless the user explicitly asked/i,
  );
  assert.match(
    messages[0]?.content ?? "",
    /For broad requests like 'best TV shows in India'/i,
  );
  assert.match(
    messages[0]?.content ?? "",
    /Default recommendation replies to a compact 5-10 item list/i,
  );
  assert.match(
    messages[0]?.content ?? "",
    /keep it numbered and easy to scan, with one brief but informative line per item/i,
  );
  assert.match(
    messages[0]?.content ?? "",
    /Never guess supporting metadata such as song-to-film, show-to-platform, title-to-release-year, or rank-to-source mappings/i,
  );
  assert.match(
    messages[0]?.content ?? "",
    /Do not use markdown emphasis, markdown links, or raw URLs in the reply/i,
  );
  assert.match(
    messages[0]?.content ?? "",
    /For non-list answers, keep the reply to 1-2 short sentences unless the user explicitly asks for more detail/i,
  );
  assert.match(
    messages[0]?.content ?? "",
    /For current-status questions, give the current result first and skip extended forecasts, background, or extra sections unless the user asked for them/i,
  );
});

test("buildResponseMessages keeps short numeric refinements exact", () => {
  const messages = buildResponseMessages("2000", {
    intent: "answer_question",
    objective: "Refine the shortlist using the new numeric constraint",
    replyStyle: "structured",
    mentionLimits: false,
  }, {
    conversationContext: "User: best restaurants in mumbai\nAssistant: What budget should I use?",
  });

  assert.match(
    messages[0]?.content ?? "",
    /Preserve every digit exactly as written/i,
  );
  assert.match(messages[1]?.content ?? "", /\b2000\b/);
});
