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

test("createMessageStore falls back when WAL mode is unavailable", () => {
  const temp = createTempDatabasePath();
  let fallbackError: (Error & { code?: string }) | undefined;
  let additionalJournalModePragma = false;

  const store = createMessageStore(temp.filePath, {
    databaseFactory(databasePath) {
      const db = new Database(databasePath);
      const originalPragma = db.pragma.bind(db);

      db.pragma = ((source: string, options?: unknown) => {
        if (source === "journal_mode = WAL") {
          const error = new Error("disk I/O error") as Error & { code?: string };
          error.code = "SQLITE_IOERR_SHMOPEN";
          throw error;
        }

        if (source.startsWith("journal_mode = ")) {
          additionalJournalModePragma = true;
        }

        return originalPragma(source, options as never);
      }) as typeof db.pragma;

      return db;
    },
    onJournalModeFallback(error) {
      fallbackError = error as Error & { code?: string };
    },
  });

  try {
    const message = store.insertMessage({
      chatId: "99",
      userId: "5",
      direction: "incoming",
      status: "received",
      text: "hello from fallback",
      telegramMessageId: 14,
      messageTimestamp: "2026-03-12T10:00:00.000Z",
      payloadJson: "{\"kind\":\"incoming\"}",
    });

    assert.equal(fallbackError?.code, "SQLITE_IOERR_SHMOPEN");
    assert.equal(additionalJournalModePragma, false);
    assert.equal(message.chatId, "99");
    assert.equal(store.listMessagesByChat("99").length, 1);
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("createMessageStore persists tool audit logs and pending confirmations", () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  try {
    const created = store.insertToolAuditLog({
      chatId: "42",
      userId: "7",
      skillName: "shell_exec",
      status: "pending_confirmation",
      userRequestText: "/shell_exec npm run build",
      commandText: "npm run build",
      requiresConfirmation: true,
      confirmationToken: "abc123",
      requestJson: JSON.stringify({
        skillName: "shell_exec",
        command: "npm run build",
      }),
    });

    const pending = store.getPendingToolAuditLog("abc123", "42", "7");
    assert.ok(pending);
    assert.equal(pending?.id, created.id);
    assert.equal(pending?.status, "pending_confirmation");

    const updated = store.updateToolAuditLog(created.id, {
      status: "completed",
      confirmedAt: "2026-03-28T10:00:00.000Z",
      durationMs: 123,
      resultSize: 18,
      outputText: "build finished ok",
      errorText: null,
    });

    assert.equal(updated.status, "completed");
    assert.equal(updated.durationMs, 123);
    assert.equal(updated.outputText, "build finished ok");
    assert.equal(store.listToolAuditLogs(10).length, 1);
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("createMessageStore persists scheduled tasks and task runs", () => {
  const temp = createTempDatabasePath();
  const store = createMessageStore(temp.filePath);

  try {
    const task = store.upsertScheduledTask({
      name: "heartbeat",
      schedule: "* * * * *",
      prompt: "Say hello",
      enabled: true,
      maxOutputTokens: 40,
      telegramChatId: "chat-42",
      runOnce: true,
      nextRunAt: "2026-03-28T10:05:00.000Z",
    });

    const dueTasks = store.listDueScheduledTasks("2026-03-28T10:05:00.000Z");
    assert.equal(dueTasks.length, 1);
    assert.equal(dueTasks[0]?.id, task.id);
    assert.equal(dueTasks[0]?.telegramChatId, "chat-42");
    assert.equal(dueTasks[0]?.runOnce, true);

    const claimed = store.markScheduledTaskRunning(task.id, "2026-03-28T10:05:01.000Z");
    assert.equal(claimed?.isRunning, true);
    assert.equal(store.markScheduledTaskRunning(task.id, "2026-03-28T10:05:02.000Z"), null);

    const updatedTask = store.updateScheduledTask(task.id, {
      telegramChatId: "chat-99",
      runOnce: false,
      isRunning: false,
      lastFinishedAt: "2026-03-28T10:05:03.000Z",
      lastDurationMs: 2000,
      lastOutputPreview: "hello",
      lastError: null,
      nextRunAt: "2026-03-28T10:06:00.000Z",
    });

    assert.equal(updatedTask.isRunning, false);
    assert.equal(updatedTask.lastOutputPreview, "hello");
    assert.equal(updatedTask.telegramChatId, "chat-99");
    assert.equal(updatedTask.runOnce, false);

    const run = store.insertScheduledTaskRun({
      taskId: task.id,
      taskName: task.name,
      status: "completed",
      startedAt: "2026-03-28T10:05:01.000Z",
      finishedAt: "2026-03-28T10:05:03.000Z",
      durationMs: 2000,
      outputText: "hello",
      errorText: null,
    });

    assert.equal(run.taskName, "heartbeat");
    assert.equal(run.status, "completed");
    assert.equal(store.listScheduledTaskRuns(10).length, 1);
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("createMessageStore migrates scheduled tasks to support telegram chat targets", () => {
  const temp = createTempDatabasePath();
  const legacyDb = new Database(temp.filePath);
  legacyDb.exec(`
    CREATE TABLE scheduled_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      schedule TEXT NOT NULL,
      prompt TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_output_tokens INTEGER NOT NULL,
      next_run_at TEXT,
      is_running INTEGER NOT NULL DEFAULT 0,
      last_started_at TEXT,
      last_finished_at TEXT,
      last_duration_ms INTEGER,
      last_error TEXT,
      last_output_preview TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  legacyDb.close();

  const store = createMessageStore(temp.filePath);

  try {
    const task = store.upsertScheduledTask({
      name: "heartbeat",
      schedule: "* * * * *",
      prompt: "Say hello",
      enabled: true,
      maxOutputTokens: 40,
      telegramChatId: "chat-42",
      runOnce: true,
      nextRunAt: "2026-03-28T10:05:00.000Z",
    });

    assert.equal(task.telegramChatId, "chat-42");
    assert.equal(task.runOnce, true);
  } finally {
    store.close();
  }

  const inspectDb = new Database(temp.filePath, { readonly: true });

  try {
    const columns = inspectDb
      .prepare("PRAGMA table_info(scheduled_tasks)")
      .all() as Array<{ name: string }>;

    assert.ok(columns.some((column) => column.name === "telegram_chat_id"));
    assert.ok(columns.some((column) => column.name === "run_once"));
  } finally {
    inspectDb.close();
    temp.cleanup();
  }
});
