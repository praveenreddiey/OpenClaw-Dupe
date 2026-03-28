import assert from "node:assert/strict";
import test from "node:test";
import { LlmRequestError } from "../src/llm.js";
import { createOllamaLlmClient } from "../src/ollama-llm.js";

test("createOllamaLlmClient generate normalizes json-like planner responses", async () => {
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> | undefined;

  const client = createOllamaLlmClient(
    {
      baseUrl: "http://127.0.0.1:11434",
      model: "llama3.2",
      embeddingModel: "nomic-embed-text",
      requestTimeoutMs: 5000,
    },
    async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

      return new Response(
        JSON.stringify({
          model: "llama3.2",
          message: {
            role: "assistant",
            content: "```json\n{\"intent\":\"answer_question\",\"objective\":\"Reply directly\",\"replyStyle\":\"concise\",\"mentionLimits\":false}\n```",
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

  assert.equal(requestedUrl, "http://127.0.0.1:11434/api/chat");
  assert.equal(requestedBody?.model, "llama3.2");
  assert.equal(requestedBody?.format, "json");
  assert.deepEqual(JSON.parse(result.text), {
    intent: "answer_question",
    objective: "Reply directly",
    replyStyle: "concise",
    mentionLimits: false,
  });
});

test("createOllamaLlmClient stream parses json line deltas", async () => {
  const encoder = new TextEncoder();
  const client = createOllamaLlmClient(
    {
      baseUrl: "http://127.0.0.1:11434",
      model: "llama3.2",
      embeddingModel: "nomic-embed-text",
      requestTimeoutMs: 5000,
    },
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  "{\"model\":\"llama3.2\",\"message\":{\"content\":\"Hello\"},\"done\":false}",
                  "{\"model\":\"llama3.2\",\"message\":{\"content\":\" world\"},\"done\":false}",
                  "{\"model\":\"llama3.2\",\"done\":true}",
                ].join("\n"),
              ),
            );
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/x-ndjson",
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
      model: "llama3.2",
    },
  ]);
});

test("createOllamaLlmClient surfaces timeouts as llm request errors", async () => {
  const client = createOllamaLlmClient(
    {
      baseUrl: "http://127.0.0.1:11434",
      model: "llama3.2",
      embeddingModel: "nomic-embed-text",
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
