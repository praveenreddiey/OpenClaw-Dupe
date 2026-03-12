import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createMessageStore } from "../src/db.js";

function createTempDatabasePath(): { filePath: string; cleanup: () => void } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "claw-dupe-db-"));
  return {
    filePath: path.join(directory, "messages.db"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("createMessageStore persists message metadata, status, and timestamps", () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  try {
    const first = store.insertMessage({
      chatId: "42",
      userId: "7",
      direction: "incoming",
      status: "received",
      text: "hello",
      telegramMessageId: 10,
      messageTimestamp: "2026-03-12T09:00:00.000Z",
      payloadJson: "{\"kind\":\"incoming\"}",
    });

    const second = store.insertMessage({
      chatId: "42",
      userId: null,
      direction: "outgoing",
      status: "processed",
      text: "Echo: hello",
      telegramMessageId: 11,
      messageTimestamp: "2026-03-12T09:00:02.000Z",
      payloadJson: "{\"kind\":\"outgoing\"}",
    });

    const updatedFirst = store.updateMessage(first.id, {
      status: "processed",
    });

    const messages = store.listMessagesByChat("42");

    assert.equal(messages.length, 2);
    assert.equal(updatedFirst.status, "processed");
    assert.equal(messages[0]?.id, first.id);
    assert.equal(messages[0]?.userId, "7");
    assert.equal(messages[0]?.direction, "incoming");
    assert.equal(messages[0]?.status, "processed");
    assert.equal(messages[0]?.messageTimestamp, "2026-03-12T09:00:00.000Z");
    assert.equal(messages[1]?.id, second.id);
    assert.equal(messages[1]?.userId, null);
    assert.equal(messages[1]?.text, "Echo: hello");
    assert.equal(messages[1]?.status, "processed");
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("createMessageStore migrates legacy tables and creates indexes", () => {
  const temp = createTempDatabasePath();
  const legacyDb = new Database(temp.filePath);
  legacyDb.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      text TEXT NOT NULL,
      telegram_message_id INTEGER,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  legacyDb.close();

  const store = createMessageStore(temp.filePath);

  try {
    const message = store.insertMessage({
      chatId: "84",
      userId: "21",
      direction: "incoming",
      status: "received",
      text: "legacy hello",
      telegramMessageId: 12,
      messageTimestamp: "2026-03-12T09:10:00.000Z",
      payloadJson: "{\"kind\":\"incoming\"}",
    });

    assert.equal(message.userId, "21");
    assert.equal(message.status, "received");
    assert.equal(message.messageTimestamp, "2026-03-12T09:10:00.000Z");
  } finally {
    store.close();
  }

  const inspectDb = new Database(temp.filePath, { readonly: true });

  try {
    const columns = inspectDb
      .prepare("PRAGMA table_info(messages)")
      .all() as Array<{ name: string }>;
    const indexes = inspectDb
      .prepare("PRAGMA index_list(messages)")
      .all() as Array<{ name: string }>;

    assert.deepEqual(
      columns.map((column) => column.name).sort(),
      [
        "chat_id",
        "created_at",
        "direction",
        "id",
        "message_timestamp",
        "payload_json",
        "status",
        "telegram_message_id",
        "text",
        "user_id",
      ],
    );
    assert.deepEqual(
      indexes.map((index) => index.name).sort(),
      [
        "idx_messages_chat_id_id",
        "idx_messages_chat_message_direction",
        "idx_messages_message_timestamp",
        "idx_messages_user_id",
      ],
    );
  } finally {
    inspectDb.close();
    temp.cleanup();
  }
});
