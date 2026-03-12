import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type MessageDirection = "incoming" | "outgoing";
export type MessageStatus = "received" | "processed" | "failed";

export type MessageRecord = {
  id: number;
  chatId: string;
  userId: string | null;
  direction: MessageDirection;
  status: MessageStatus;
  text: string;
  telegramMessageId: number | null;
  messageTimestamp: string | null;
  payloadJson: string | null;
  createdAt: string;
};

export type NewMessageRecord = {
  chatId: string;
  userId?: string | null;
  direction: MessageDirection;
  status: MessageStatus;
  text: string;
  telegramMessageId?: number | null;
  messageTimestamp?: string | null;
  payloadJson?: string | null;
};

export type MessageUpdate = {
  status?: MessageStatus;
  telegramMessageId?: number | null;
  messageTimestamp?: string | null;
  payloadJson?: string | null;
};

export type MessageStore = {
  insertMessage(message: NewMessageRecord): MessageRecord;
  updateMessage(id: number, update: MessageUpdate): MessageRecord;
  listMessagesByChat(chatId: string): MessageRecord[];
  close(): void;
};

type MessageRow = {
  id: number;
  chat_id: string;
  user_id: string | null;
  direction: MessageDirection;
  status: MessageStatus;
  text: string;
  telegram_message_id: number | null;
  message_timestamp: string | null;
  payload_json: string | null;
  created_at: string;
};

function mapRow(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    userId: row.user_id,
    direction: row.direction,
    status: row.status,
    text: row.text,
    telegramMessageId: row.telegram_message_id,
    messageTimestamp: row.message_timestamp,
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

function hasOwnProperty<Key extends PropertyKey>(
  value: object,
  key: Key,
): value is Record<Key, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function migrateMessagesTable(db: Database.Database): void {
  const columns = new Set(
    (db.pragma("table_info(messages)", { simple: false }) as Array<{ name: string }>)
      .map((column) => column.name),
  );

  if (!columns.has("user_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN user_id TEXT");
  }

  if (!columns.has("status")) {
    db.exec("ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'received'");
  }

  if (!columns.has("message_timestamp")) {
    db.exec("ALTER TABLE messages ADD COLUMN message_timestamp TEXT");
  }
}

export function createMessageStore(databasePath: string): MessageStore {
  ensureDatabaseDirectory(databasePath);

  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      user_id TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
      status TEXT NOT NULL CHECK(status IN ('received', 'processed', 'failed')),
      text TEXT NOT NULL,
      telegram_message_id INTEGER,
      message_timestamp TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  migrateMessagesTable(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_chat_id_id
    ON messages(chat_id, id);

    CREATE INDEX IF NOT EXISTS idx_messages_user_id
    ON messages(user_id);

    CREATE INDEX IF NOT EXISTS idx_messages_chat_message_direction
    ON messages(chat_id, telegram_message_id, direction);

    CREATE INDEX IF NOT EXISTS idx_messages_message_timestamp
    ON messages(message_timestamp);
  `);

  const insertStatement = db.prepare(`
    INSERT INTO messages (
      chat_id,
      user_id,
      direction,
      status,
      text,
      telegram_message_id,
      message_timestamp,
      payload_json
    ) VALUES (
      @chat_id,
      @user_id,
      @direction,
      @status,
      @text,
      @telegram_message_id,
      @message_timestamp,
      @payload_json
    )
  `);

  const getByIdStatement = db.prepare(`
    SELECT
      id,
      chat_id,
      user_id,
      direction,
      status,
      text,
      telegram_message_id,
      message_timestamp,
      payload_json,
      created_at
    FROM messages
    WHERE id = ?
  `);

  const updateStatement = db.prepare(`
    UPDATE messages
    SET
      status = @status,
      telegram_message_id = @telegram_message_id,
      message_timestamp = @message_timestamp,
      payload_json = @payload_json
    WHERE id = @id
  `);

  const listByChatStatement = db.prepare(`
    SELECT
      id,
      chat_id,
      user_id,
      direction,
      status,
      text,
      telegram_message_id,
      message_timestamp,
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
        user_id: message.userId ?? null,
        direction: message.direction,
        status: message.status,
        text: message.text,
        telegram_message_id: message.telegramMessageId ?? null,
        message_timestamp: message.messageTimestamp ?? null,
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

    updateMessage(id, update) {
      const existing = getByIdStatement.get(id) as MessageRow | undefined;
      if (!existing) {
        throw new Error(`Message ${id} could not be found in SQLite`);
      }

      const nextStatus = hasOwnProperty(update, "status")
        ? (update.status as MessageStatus)
        : existing.status;
      const nextTelegramMessageId = hasOwnProperty(update, "telegramMessageId")
        ? (update.telegramMessageId ?? null)
        : existing.telegram_message_id;
      const nextMessageTimestamp = hasOwnProperty(update, "messageTimestamp")
        ? (update.messageTimestamp ?? null)
        : existing.message_timestamp;
      const nextPayloadJson = hasOwnProperty(update, "payloadJson")
        ? (update.payloadJson ?? null)
        : existing.payload_json;

      updateStatement.run({
        id,
        status: nextStatus,
        telegram_message_id: nextTelegramMessageId,
        message_timestamp: nextMessageTimestamp,
        payload_json: nextPayloadJson,
      });

      const row = getByIdStatement.get(id) as MessageRow | undefined;
      if (!row) {
        throw new Error(`Updated message ${id} could not be read back from SQLite`);
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
