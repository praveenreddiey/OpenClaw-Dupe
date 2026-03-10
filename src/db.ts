import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type MessageDirection = "incoming" | "outgoing";

export type MessageRecord = {
  id: number;
  chatId: string;
  direction: MessageDirection;
  text: string;
  telegramMessageId: number | null;
  payloadJson: string | null;
  createdAt: string;
};

export type NewMessageRecord = {
  chatId: string;
  direction: MessageDirection;
  text: string;
  telegramMessageId?: number | null;
  payloadJson?: string | null;
};

export type MessageStore = {
  insertMessage(message: NewMessageRecord): MessageRecord;
  listMessagesByChat(chatId: string): MessageRecord[];
  close(): void;
};

type MessageRow = {
  id: number;
  chat_id: string;
  direction: MessageDirection;
  text: string;
  telegram_message_id: number | null;
  payload_json: string | null;
  created_at: string;
};

function mapRow(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    direction: row.direction,
    text: row.text,
    telegramMessageId: row.telegram_message_id,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}

function ensureDatabaseDirectory(databasePath: string): void {
  if (databasePath === ":memory:") {
    return;
  }

  mkdirSync(path.dirname(databasePath), { recursive: true });
}

export function createMessageStore(databasePath: string): MessageStore {
  ensureDatabaseDirectory(databasePath);

  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
      text TEXT NOT NULL,
      telegram_message_id INTEGER,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const insertStatement = db.prepare(`
    INSERT INTO messages (
      chat_id,
      direction,
      text,
      telegram_message_id,
      payload_json
    ) VALUES (
      @chat_id,
      @direction,
      @text,
      @telegram_message_id,
      @payload_json
    )
  `);

  const getByIdStatement = db.prepare(`
    SELECT
      id,
      chat_id,
      direction,
      text,
      telegram_message_id,
      payload_json,
      created_at
    FROM messages
    WHERE id = ?
  `);

  const listByChatStatement = db.prepare(`
    SELECT
      id,
      chat_id,
      direction,
      text,
      telegram_message_id,
      payload_json,
      created_at
    FROM messages
    WHERE chat_id = ?
    ORDER BY id ASC
  `);

  return {
    insertMessage(message) {
      const result = insertStatement.run({
        chat_id: message.chatId,
        direction: message.direction,
        text: message.text,
        telegram_message_id: message.telegramMessageId ?? null,
        payload_json: message.payloadJson ?? null,
      });

      const row = getByIdStatement.get(Number(result.lastInsertRowid)) as
        | MessageRow
        | undefined;
      if (!row) {
        throw new Error("Inserted message could not be read back from SQLite");
      }

      return mapRow(row);
    },

    listMessagesByChat(chatId) {
      return (listByChatStatement.all(chatId) as MessageRow[]).map(mapRow);
    },

    close() {
      db.close();
    },
  };
}
