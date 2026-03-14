import test from "node:test";
import assert from "node:assert/strict";
import { LlmRequestError } from "../src/llm.js";
import { createOpenAILlmClient } from "../src/openai-llm.js";

test("createOpenAILlmClient generate sends structured requests and parses text", async () => {
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> | undefined;

  const client = createOpenAILlmClient(
    {
      apiKey: "test-api-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5-mini",
      embeddingModel: "text-embedding-3-small",
      requestTimeoutMs: 5000,
    },
    async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

      return new Response(
        JSON.stringify({
          model: "gpt-5-mini",
          choices: [
            {
              message: {
                content: "Planned text",
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  );

  const result = await client.generate({
    messages: [
      {
        role: "system",
        content: "Return JSON only",
      },
      {
        role: "user",
        content: "hello",
      },
    ],
    maxOutputTokens: 120,
    responseFormat: "json_object",
  });

  assert.equal(requestedUrl, "https://api.openai.com/v1/chat/completions");
  assert.equal(requestedBody?.model, "gpt-5-mini");
  assert.equal(requestedBody?.max_completion_tokens, 120);
  assert.equal(requestedBody?.reasoning_effort, "low");
  assert.deepEqual(requestedBody?.response_format, {
    type: "json_object",
  });
  assert.equal(result.text, "Planned text");
  assert.equal(result.usage?.inputTokens, 10);
  assert.equal(result.usage?.outputTokens, 5);
});

test("createOpenAILlmClient stream parses SSE text deltas", async () => {
  const encoder = new TextEncoder();
  const client = createOpenAILlmClient(
    {
      apiKey: "test-api-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5-mini",
      embeddingModel: "text-embedding-3-small",
      requestTimeoutMs: 5000,
    },
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  "data: {\"model\":\"gpt-5-mini\",\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}",
                  "",
                  "data: {\"model\":\"gpt-5-mini\",\"choices\":[{\"delta\":{\"content\":\" world\"}}]}",
                  "",
                  "data: [DONE]",
                  "",
                ].join("\n"),
              ),
            );
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        },
      ),
  );

  const events = [];
  for await (const event of client.stream({
    messages: [
      {
        role: "system",
        content: "Be concise",
      },
      {
        role: "user",
        content: "hello",
      },
    ],
    maxOutputTokens: 200,
  })) {
    events.push(event);
  }

  assert.deepEqual(events, [
    {
      type: "text-delta",
      delta: "Hello",
    },
    {
      type: "text-delta",
      delta: " world",
    },
    {
      type: "completed",
      text: "Hello world",
      model: "gpt-5-mini",
    },
  ]);
});

test("createOpenAILlmClient stream derives deltas from snapshot-style events", async () => {
  const encoder = new TextEncoder();
  const client = createOpenAILlmClient(
    {
      apiKey: "test-api-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5-mini",
      embeddingModel: "text-embedding-3-small",
      requestTimeoutMs: 5000,
    },
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  "data: {\"model\":\"gpt-5-mini\",\"choices\":[{\"message\":{\"content\":\"Hello\"}}]}",
                  "",
                  "data: {\"model\":\"gpt-5-mini\",\"choices\":[{\"message\":{\"content\":\"Hello world\"}}]}",
                  "",
                  "data: [DONE]",
                  "",
                ].join("\n"),
              ),
            );
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        },
      ),
  );

  const events = [];
  for await (const event of client.stream({
    messages: [
      {
        role: "system",
        content: "Be concise",
      },
      {
        role: "user",
        content: "hello",
      },
    ],
    maxOutputTokens: 200,
  })) {
    events.push(event);
  }

  assert.deepEqual(events, [
    {
      type: "text-delta",
      delta: "Hello",
    },
    {
      type: "text-delta",
      delta: " world",
    },
    {
      type: "completed",
      text: "Hello world",
      model: "gpt-5-mini",
    },
  ]);
});

test("createOpenAILlmClient returns embeddings through the unified interface", async () => {
  const client = createOpenAILlmClient(
    {
      apiKey: "test-api-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5-mini",
      embeddingModel: "text-embedding-3-small",
      requestTimeoutMs: 5000,
    },
    async () =>
      new Response(
        JSON.stringify({
          model: "text-embedding-3-small",
          data: [
            {
              embedding: [0.1, 0.2, 0.3],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
  );

  const result = await client.embeddings({
    input: "hello",
  });

  assert.equal(result.model, "text-embedding-3-small");
  assert.deepEqual(result.vectors, [[0.1, 0.2, 0.3]]);
});

test("createOpenAILlmClient surfaces timeouts as llm request errors", async () => {
  const client = createOpenAILlmClient(
    {
      apiKey: "test-api-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5-mini",
      embeddingModel: "text-embedding-3-small",
      requestTimeoutMs: 5,
    },
    async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("signal missing"));
          return;
        }

        signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        );
      }),
  );

  await assert.rejects(
    () =>
      client.generate({
        messages: [
          {
            role: "system",
            content: "Be concise",
          },
          {
            role: "user",
            content: "hello",
          },
        ],
        maxOutputTokens: 20,
      }),
    (error: unknown) =>
      error instanceof LlmRequestError &&
      error.statusCode === 504 &&
      error.message.includes("timed out"),
  );
});
