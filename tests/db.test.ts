import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createMessageStore } from "../src/db.js";

function createTempDatabasePath(): { filePath: string; cleanup: () => void } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "claw-dupe-db-"));
  return {
    filePath: path.join(directory, "messages.db"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("createMessageStore persists and reads chat messages in order", () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  try {
    const first = store.insertMessage({
      chatId: "42",
      direction: "incoming",
      text: "hello",
      telegramMessageId: 10,
      payloadJson: "{\"kind\":\"incoming\"}",
    });

    const second = store.insertMessage({
      chatId: "42",
      direction: "outgoing",
      text: "Echo: hello",
      telegramMessageId: 11,
      payloadJson: "{\"kind\":\"outgoing\"}",
    });

    const messages = store.listMessagesByChat("42");

    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.id, first.id);
    assert.equal(messages[0]?.direction, "incoming");
    assert.equal(messages[1]?.id, second.id);
    assert.equal(messages[1]?.text, "Echo: hello");
  } finally {
    store.close();
    temp.cleanup();
  }
});
