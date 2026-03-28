import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { SkillName } from "./skills.js";

export type MessageDirection = "incoming" | "outgoing";
export type MessageStatus = "received" | "processed" | "failed";
export type ToolAuditStatus =
  | "started"
  | "completed"
  | "failed"
  | "blocked"
  | "pending_confirmation"
  | "cancelled";
export type ScheduledTaskRunStatus =
  | "completed"
  | "failed"
  | "rate_limited"
  | "recovered";

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
  text?: string;
  telegramMessageId?: number | null;
  messageTimestamp?: string | null;
  payloadJson?: string | null;
};

export type ToolAuditRecord = {
  id: number;
  chatId: string;
  userId: string | null;
  skillName: SkillName;
  status: ToolAuditStatus;
  userRequestText: string;
  targetPath: string | null;
  commandText: string | null;
  outputText: string | null;
  errorText: string | null;
  durationMs: number | null;
  resultSize: number | null;
  requiresConfirmation: boolean;
  confirmationToken: string | null;
  requestJson: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewToolAuditRecord = {
  chatId: string;
  userId?: string | null;
  skillName: SkillName;
  status: ToolAuditStatus;
  userRequestText: string;
  targetPath?: string | null;
  commandText?: string | null;
  outputText?: string | null;
  errorText?: string | null;
  durationMs?: number | null;
  resultSize?: number | null;
  requiresConfirmation?: boolean;
  confirmationToken?: string | null;
  requestJson?: string | null;
  confirmedAt?: string | null;
};

export type ToolAuditUpdate = {
  status?: ToolAuditStatus;
  outputText?: string | null;
  errorText?: string | null;
  durationMs?: number | null;
  resultSize?: number | null;
  requiresConfirmation?: boolean;
  confirmationToken?: string | null;
  requestJson?: string | null;
  confirmedAt?: string | null;
};

export type ScheduledTaskRecord = {
  id: number;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  maxOutputTokens: number;
  telegramChatId: string | null;
  runOnce: boolean;
  nextRunAt: string | null;
  isRunning: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastOutputPreview: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledTaskUpsert = {
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  maxOutputTokens: number;
  telegramChatId?: string | null;
  runOnce?: boolean;
  nextRunAt: string | null;
};

export type ScheduledTaskUpdate = {
  schedule?: string;
  prompt?: string;
  enabled?: boolean;
  maxOutputTokens?: number;
  telegramChatId?: string | null;
  runOnce?: boolean;
  nextRunAt?: string | null;
  isRunning?: boolean;
  lastStartedAt?: string | null;
  lastFinishedAt?: string | null;
  lastDurationMs?: number | null;
  lastError?: string | null;
  lastOutputPreview?: string | null;
};

export type ScheduledTaskRunRecord = {
  id: number;
  taskId: number;
  taskName: string;
  status: ScheduledTaskRunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number | null;
  outputText: string | null;
  errorText: string | null;
  createdAt: string;
};

export type NewScheduledTaskRunRecord = {
  taskId: number;
  taskName: string;
  status: ScheduledTaskRunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs?: number | null;
  outputText?: string | null;
  errorText?: string | null;
};

export type MessageStore = {
  insertMessage(message: NewMessageRecord): MessageRecord;
  updateMessage(id: number, update: MessageUpdate): MessageRecord;
  listMessagesByChat(chatId: string): MessageRecord[];
  insertToolAuditLog(entry: NewToolAuditRecord): ToolAuditRecord;
  updateToolAuditLog(id: number, update: ToolAuditUpdate): ToolAuditRecord;
  getPendingToolAuditLog(
    confirmationToken: string,
    chatId: string,
    userId?: string | null,
  ): ToolAuditRecord | null;
  listToolAuditLogs(limit?: number): ToolAuditRecord[];
  upsertScheduledTask(task: ScheduledTaskUpsert): ScheduledTaskRecord;
  getScheduledTaskByName(name: string): ScheduledTaskRecord | null;
  updateScheduledTask(id: number, update: ScheduledTaskUpdate): ScheduledTaskRecord;
  listScheduledTasks(): ScheduledTaskRecord[];
  listDueScheduledTasks(nowIso: string, limit?: number): ScheduledTaskRecord[];
  markScheduledTaskRunning(id: number, startedAt: string): ScheduledTaskRecord | null;
  releaseStaleScheduledTasks(staleBeforeIso: string): number;
  insertScheduledTaskRun(run: NewScheduledTaskRunRecord): ScheduledTaskRunRecord;
  listScheduledTaskRuns(limit?: number): ScheduledTaskRunRecord[];
  close(): void;
};

type MessageStoreOptions = {
  databaseFactory?: (databasePath: string) => Database.Database;
  onJournalModeFallback?: (error: unknown) => void;
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

type ToolAuditRow = {
  id: number;
  chat_id: string;
  user_id: string | null;
  skill_name: SkillName;
  status: ToolAuditStatus;
  user_request_text: string;
  target_path: string | null;
  command_text: string | null;
  output_text: string | null;
  error_text: string | null;
  duration_ms: number | null;
  result_size: number | null;
  requires_confirmation: number;
  confirmation_token: string | null;
  request_json: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

type ScheduledTaskRow = {
  id: number;
  name: string;
  schedule: string;
  prompt: string;
  enabled: number;
  max_output_tokens: number;
  telegram_chat_id: string | null;
  run_once: number;
  next_run_at: string | null;
  is_running: number;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_duration_ms: number | null;
  last_error: string | null;
  last_output_preview: string | null;
  created_at: string;
  updated_at: string;
};

type ScheduledTaskRunRow = {
  id: number;
  task_id: number;
  task_name: string;
  status: ScheduledTaskRunStatus;
  started_at: string;
  finished_at: string;
  duration_ms: number | null;
  output_text: string | null;
  error_text: string | null;
  created_at: string;
};

function mapMessageRow(row: MessageRow): MessageRecord {
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

function mapToolAuditRow(row: ToolAuditRow): ToolAuditRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    userId: row.user_id,
    skillName: row.skill_name,
    status: row.status,
    userRequestText: row.user_request_text,
    targetPath: row.target_path,
    commandText: row.command_text,
    outputText: row.output_text,
    errorText: row.error_text,
    durationMs: row.duration_ms,
    resultSize: row.result_size,
    requiresConfirmation: row.requires_confirmation === 1,
    confirmationToken: row.confirmation_token,
    requestJson: row.request_json,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapScheduledTaskRow(row: ScheduledTaskRow): ScheduledTaskRecord {
  return {
    id: row.id,
    name: row.name,
    schedule: row.schedule,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    maxOutputTokens: row.max_output_tokens,
    telegramChatId: row.telegram_chat_id,
    runOnce: row.run_once === 1,
    nextRunAt: row.next_run_at,
    isRunning: row.is_running === 1,
    lastStartedAt: row.last_started_at,
    lastFinishedAt: row.last_finished_at,
    lastDurationMs: row.last_duration_ms,
    lastError: row.last_error,
    lastOutputPreview: row.last_output_preview,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapScheduledTaskRunRow(row: ScheduledTaskRunRow): ScheduledTaskRunRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    taskName: row.task_name,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    outputText: row.output_text,
    errorText: row.error_text,
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configureJournalMode(
  db: Database.Database,
  onJournalModeFallback?: (error: unknown) => void,
): void {
  try {
    db.pragma("journal_mode = WAL");
  } catch (error) {
    if (onJournalModeFallback) {
      onJournalModeFallback(error);
    } else {
      console.warn(
        `[db] WAL journal mode unavailable; continuing with SQLite default journal mode: ${getErrorMessage(error)}`,
      );
    }
  }
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

function migrateScheduledTasksTable(db: Database.Database): void {
  const columns = new Set(
    (db.pragma("table_info(scheduled_tasks)", { simple: false }) as Array<{ name: string }>)
      .map((column) => column.name),
  );

  if (!columns.has("telegram_chat_id")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN telegram_chat_id TEXT");
  }

  if (!columns.has("run_once")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN run_once INTEGER NOT NULL DEFAULT 0");
  }
}

export function createMessageStore(
  databasePath: string,
  options: MessageStoreOptions = {},
): MessageStore {
  ensureDatabaseDirectory(databasePath);

  const db = options.databaseFactory?.(databasePath) ?? new Database(databasePath);
  configureJournalMode(db, options.onJournalModeFallback);

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      user_id TEXT,
      skill_name TEXT NOT NULL CHECK(skill_name IN ('fs_read', 'fs_write', 'shell_exec')),
      status TEXT NOT NULL CHECK(status IN ('started', 'completed', 'failed', 'blocked', 'pending_confirmation', 'cancelled')),
      user_request_text TEXT NOT NULL,
      target_path TEXT,
      command_text TEXT,
      output_text TEXT,
      error_text TEXT,
      duration_ms INTEGER,
      result_size INTEGER,
      requires_confirmation INTEGER NOT NULL DEFAULT 0,
      confirmation_token TEXT,
      request_json TEXT,
      confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_tool_audit_logs_chat_created
    ON tool_audit_logs(chat_id, created_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_audit_logs_confirmation_token
    ON tool_audit_logs(confirmation_token)
    WHERE confirmation_token IS NOT NULL;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      schedule TEXT NOT NULL,
      prompt TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_output_tokens INTEGER NOT NULL,
      telegram_chat_id TEXT,
      run_once INTEGER NOT NULL DEFAULT 0,
      next_run_at TEXT,
      is_running INTEGER NOT NULL DEFAULT 0,
      last_started_at TEXT,
      last_finished_at TEXT,
      last_duration_ms INTEGER,
      last_error TEXT,
      last_output_preview TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run
    ON scheduled_tasks(enabled, is_running, next_run_at);
  `);
  migrateScheduledTasksTable(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      task_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('completed', 'failed', 'rate_limited', 'recovered')),
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      duration_ms INTEGER,
      output_text TEXT,
      error_text TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(task_id) REFERENCES scheduled_tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task_created
    ON scheduled_task_runs(task_id, created_at DESC);
  `);

  const insertMessageStatement = db.prepare(`
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

  const getMessageByIdStatement = db.prepare(`
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

  const updateMessageStatement = db.prepare(`
    UPDATE messages
    SET
      status = @status,
      text = @text,
      telegram_message_id = @telegram_message_id,
      message_timestamp = @message_timestamp,
      payload_json = @payload_json
    WHERE id = @id
  `);

  const listMessagesByChatStatement = db.prepare(`
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

  const insertToolAuditStatement = db.prepare(`
    INSERT INTO tool_audit_logs (
      chat_id,
      user_id,
      skill_name,
      status,
      user_request_text,
      target_path,
      command_text,
      output_text,
      error_text,
      duration_ms,
      result_size,
      requires_confirmation,
      confirmation_token,
      request_json,
      confirmed_at
    ) VALUES (
      @chat_id,
      @user_id,
      @skill_name,
      @status,
      @user_request_text,
      @target_path,
      @command_text,
      @output_text,
      @error_text,
      @duration_ms,
      @result_size,
      @requires_confirmation,
      @confirmation_token,
      @request_json,
      @confirmed_at
    )
  `);

  const getToolAuditByIdStatement = db.prepare(`
    SELECT
      id,
      chat_id,
      user_id,
      skill_name,
      status,
      user_request_text,
      target_path,
      command_text,
      output_text,
      error_text,
      duration_ms,
      result_size,
      requires_confirmation,
      confirmation_token,
      request_json,
      confirmed_at,
      created_at,
      updated_at
    FROM tool_audit_logs
    WHERE id = ?
  `);

  const updateToolAuditStatement = db.prepare(`
    UPDATE tool_audit_logs
    SET
      status = @status,
      output_text = @output_text,
      error_text = @error_text,
      duration_ms = @duration_ms,
      result_size = @result_size,
      requires_confirmation = @requires_confirmation,
      confirmation_token = @confirmation_token,
      request_json = @request_json,
      confirmed_at = @confirmed_at,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `);

  const getPendingToolAuditByTokenStatement = db.prepare(`
    SELECT
      id,
      chat_id,
      user_id,
      skill_name,
      status,
      user_request_text,
      target_path,
      command_text,
      output_text,
      error_text,
      duration_ms,
      result_size,
      requires_confirmation,
      confirmation_token,
      request_json,
      confirmed_at,
      created_at,
      updated_at
    FROM tool_audit_logs
    WHERE confirmation_token = @confirmation_token
      AND chat_id = @chat_id
      AND status = 'pending_confirmation'
      AND (@user_id IS NULL OR user_id = @user_id)
    ORDER BY id DESC
    LIMIT 1
  `);

  const listToolAuditLogsStatement = db.prepare(`
    SELECT
      id,
      chat_id,
      user_id,
      skill_name,
      status,
      user_request_text,
      target_path,
      command_text,
      output_text,
      error_text,
      duration_ms,
      result_size,
      requires_confirmation,
      confirmation_token,
      request_json,
      confirmed_at,
      created_at,
      updated_at
    FROM tool_audit_logs
    ORDER BY id DESC
    LIMIT ?
  `);

  const upsertScheduledTaskStatement = db.prepare(`
    INSERT INTO scheduled_tasks (
      name,
      schedule,
      prompt,
      enabled,
      max_output_tokens,
      telegram_chat_id,
      run_once,
      next_run_at,
      is_running,
      last_started_at,
      last_finished_at,
      last_duration_ms,
      last_error,
      last_output_preview,
      updated_at
    ) VALUES (
      @name,
      @schedule,
      @prompt,
      @enabled,
      @max_output_tokens,
      @telegram_chat_id,
      @run_once,
      @next_run_at,
      0,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(name) DO UPDATE SET
      schedule = excluded.schedule,
      prompt = excluded.prompt,
      enabled = excluded.enabled,
      max_output_tokens = excluded.max_output_tokens,
      telegram_chat_id = excluded.telegram_chat_id,
      run_once = excluded.run_once,
      next_run_at = excluded.next_run_at,
      updated_at = CURRENT_TIMESTAMP
  `);

  const getScheduledTaskByNameStatement = db.prepare(`
    SELECT
      id,
      name,
      schedule,
      prompt,
      enabled,
      max_output_tokens,
      telegram_chat_id,
      run_once,
      next_run_at,
      is_running,
      last_started_at,
      last_finished_at,
      last_duration_ms,
      last_error,
      last_output_preview,
      created_at,
      updated_at
    FROM scheduled_tasks
    WHERE name = ?
  `);

  const getScheduledTaskByIdStatement = db.prepare(`
    SELECT
      id,
      name,
      schedule,
      prompt,
      enabled,
      max_output_tokens,
      telegram_chat_id,
      run_once,
      next_run_at,
      is_running,
      last_started_at,
      last_finished_at,
      last_duration_ms,
      last_error,
      last_output_preview,
      created_at,
      updated_at
    FROM scheduled_tasks
    WHERE id = ?
  `);

  const updateScheduledTaskStatement = db.prepare(`
    UPDATE scheduled_tasks
    SET
      schedule = @schedule,
      prompt = @prompt,
      enabled = @enabled,
      max_output_tokens = @max_output_tokens,
      telegram_chat_id = @telegram_chat_id,
      run_once = @run_once,
      next_run_at = @next_run_at,
      is_running = @is_running,
      last_started_at = @last_started_at,
      last_finished_at = @last_finished_at,
      last_duration_ms = @last_duration_ms,
      last_error = @last_error,
      last_output_preview = @last_output_preview,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `);

  const listScheduledTasksStatement = db.prepare(`
    SELECT
      id,
      name,
      schedule,
      prompt,
      enabled,
      max_output_tokens,
      telegram_chat_id,
      run_once,
      next_run_at,
      is_running,
      last_started_at,
      last_finished_at,
      last_duration_ms,
      last_error,
      last_output_preview,
      created_at,
      updated_at
    FROM scheduled_tasks
    ORDER BY name ASC
  `);

  const listDueScheduledTasksStatement = db.prepare(`
    SELECT
      id,
      name,
      schedule,
      prompt,
      enabled,
      max_output_tokens,
      telegram_chat_id,
      run_once,
      next_run_at,
      is_running,
      last_started_at,
      last_finished_at,
      last_duration_ms,
      last_error,
      last_output_preview,
      created_at,
      updated_at
    FROM scheduled_tasks
    WHERE enabled = 1
      AND is_running = 0
      AND next_run_at IS NOT NULL
      AND next_run_at <= @now_iso
    ORDER BY next_run_at ASC, id ASC
    LIMIT @limit
  `);

  const markScheduledTaskRunningStatement = db.prepare(`
    UPDATE scheduled_tasks
    SET
      is_running = 1,
      last_started_at = @started_at,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
      AND is_running = 0
  `);

  const releaseStaleScheduledTasksStatement = db.prepare(`
    UPDATE scheduled_tasks
    SET
      is_running = 0,
      updated_at = CURRENT_TIMESTAMP
    WHERE is_running = 1
      AND last_started_at IS NOT NULL
      AND last_started_at <= ?
  `);

  const insertScheduledTaskRunStatement = db.prepare(`
    INSERT INTO scheduled_task_runs (
      task_id,
      task_name,
      status,
      started_at,
      finished_at,
      duration_ms,
      output_text,
      error_text
    ) VALUES (
      @task_id,
      @task_name,
      @status,
      @started_at,
      @finished_at,
      @duration_ms,
      @output_text,
      @error_text
    )
  `);

  const getScheduledTaskRunByIdStatement = db.prepare(`
    SELECT
      id,
      task_id,
      task_name,
      status,
      started_at,
      finished_at,
      duration_ms,
      output_text,
      error_text,
      created_at
    FROM scheduled_task_runs
    WHERE id = ?
  `);

  const listScheduledTaskRunsStatement = db.prepare(`
    SELECT
      id,
      task_id,
      task_name,
      status,
      started_at,
      finished_at,
      duration_ms,
      output_text,
      error_text,
      created_at
    FROM scheduled_task_runs
    ORDER BY id DESC
    LIMIT ?
  `);

  return {
    insertMessage(message) {
      const result = insertMessageStatement.run({
        chat_id: message.chatId,
        user_id: message.userId ?? null,
        direction: message.direction,
        status: message.status,
        text: message.text,
        telegram_message_id: message.telegramMessageId ?? null,
        message_timestamp: message.messageTimestamp ?? null,
        payload_json: message.payloadJson ?? null,
      });

      const row = getMessageByIdStatement.get(Number(result.lastInsertRowid)) as
        | MessageRow
        | undefined;
      if (!row) {
        throw new Error("Inserted message could not be read back from SQLite");
      }

      return mapMessageRow(row);
    },

    updateMessage(id, update) {
      const existing = getMessageByIdStatement.get(id) as MessageRow | undefined;
      if (!existing) {
        throw new Error(`Message ${id} could not be found in SQLite`);
      }

      const nextStatus = hasOwnProperty(update, "status")
        ? (update.status as MessageStatus)
        : existing.status;
      const nextText = hasOwnProperty(update, "text")
        ? String(update.text ?? existing.text)
        : existing.text;
      const nextTelegramMessageId = hasOwnProperty(update, "telegramMessageId")
        ? (update.telegramMessageId ?? null)
        : existing.telegram_message_id;
      const nextMessageTimestamp = hasOwnProperty(update, "messageTimestamp")
        ? (update.messageTimestamp ?? null)
        : existing.message_timestamp;
      const nextPayloadJson = hasOwnProperty(update, "payloadJson")
        ? (update.payloadJson ?? null)
        : existing.payload_json;

      updateMessageStatement.run({
        id,
        status: nextStatus,
        text: nextText,
        telegram_message_id: nextTelegramMessageId,
        message_timestamp: nextMessageTimestamp,
        payload_json: nextPayloadJson,
      });

      const row = getMessageByIdStatement.get(id) as MessageRow | undefined;
      if (!row) {
        throw new Error(`Updated message ${id} could not be read back from SQLite`);
      }

      return mapMessageRow(row);
    },

    listMessagesByChat(chatId) {
      return (listMessagesByChatStatement.all(chatId) as MessageRow[]).map(
        mapMessageRow,
      );
    },

    insertToolAuditLog(entry) {
      const result = insertToolAuditStatement.run({
        chat_id: entry.chatId,
        user_id: entry.userId ?? null,
        skill_name: entry.skillName,
        status: entry.status,
        user_request_text: entry.userRequestText,
        target_path: entry.targetPath ?? null,
        command_text: entry.commandText ?? null,
        output_text: entry.outputText ?? null,
        error_text: entry.errorText ?? null,
        duration_ms: entry.durationMs ?? null,
        result_size: entry.resultSize ?? null,
        requires_confirmation: entry.requiresConfirmation ? 1 : 0,
        confirmation_token: entry.confirmationToken ?? null,
        request_json: entry.requestJson ?? null,
        confirmed_at: entry.confirmedAt ?? null,
      });

      const row = getToolAuditByIdStatement.get(Number(result.lastInsertRowid)) as
        | ToolAuditRow
        | undefined;
      if (!row) {
        throw new Error("Inserted tool audit log could not be read back from SQLite");
      }

      return mapToolAuditRow(row);
    },

    updateToolAuditLog(id, update) {
      const existing = getToolAuditByIdStatement.get(id) as ToolAuditRow | undefined;
      if (!existing) {
        throw new Error(`Tool audit log ${id} could not be found in SQLite`);
      }

      updateToolAuditStatement.run({
        id,
        status: hasOwnProperty(update, "status")
          ? update.status ?? existing.status
          : existing.status,
        output_text: hasOwnProperty(update, "outputText")
          ? update.outputText ?? null
          : existing.output_text,
        error_text: hasOwnProperty(update, "errorText")
          ? update.errorText ?? null
          : existing.error_text,
        duration_ms: hasOwnProperty(update, "durationMs")
          ? update.durationMs ?? null
          : existing.duration_ms,
        result_size: hasOwnProperty(update, "resultSize")
          ? update.resultSize ?? null
          : existing.result_size,
        requires_confirmation: hasOwnProperty(update, "requiresConfirmation")
          ? (update.requiresConfirmation ? 1 : 0)
          : existing.requires_confirmation,
        confirmation_token: hasOwnProperty(update, "confirmationToken")
          ? update.confirmationToken ?? null
          : existing.confirmation_token,
        request_json: hasOwnProperty(update, "requestJson")
          ? update.requestJson ?? null
          : existing.request_json,
        confirmed_at: hasOwnProperty(update, "confirmedAt")
          ? update.confirmedAt ?? null
          : existing.confirmed_at,
      });

      const row = getToolAuditByIdStatement.get(id) as ToolAuditRow | undefined;
      if (!row) {
        throw new Error(`Updated tool audit log ${id} could not be read back from SQLite`);
      }

      return mapToolAuditRow(row);
    },

    getPendingToolAuditLog(confirmationToken, chatId, userId) {
      const row = getPendingToolAuditByTokenStatement.get({
        confirmation_token: confirmationToken,
        chat_id: chatId,
        user_id: userId ?? null,
      }) as ToolAuditRow | undefined;

      return row ? mapToolAuditRow(row) : null;
    },

    listToolAuditLogs(limit = 50) {
      return (listToolAuditLogsStatement.all(limit) as ToolAuditRow[]).map(
        mapToolAuditRow,
      );
    },

    upsertScheduledTask(task) {
      upsertScheduledTaskStatement.run({
        name: task.name,
        schedule: task.schedule,
        prompt: task.prompt,
        enabled: task.enabled ? 1 : 0,
        max_output_tokens: task.maxOutputTokens,
        telegram_chat_id: task.telegramChatId ?? null,
        run_once: task.runOnce ? 1 : 0,
        next_run_at: task.nextRunAt,
      });

      const row = getScheduledTaskByNameStatement.get(task.name) as
        | ScheduledTaskRow
        | undefined;
      if (!row) {
        throw new Error(`Scheduled task '${task.name}' could not be read back from SQLite`);
      }

      return mapScheduledTaskRow(row);
    },

    getScheduledTaskByName(name) {
      const row = getScheduledTaskByNameStatement.get(name) as
        | ScheduledTaskRow
        | undefined;
      return row ? mapScheduledTaskRow(row) : null;
    },

    updateScheduledTask(id, update) {
      const existing = getScheduledTaskByIdStatement.get(id) as
        | ScheduledTaskRow
        | undefined;
      if (!existing) {
        throw new Error(`Scheduled task ${id} could not be found in SQLite`);
      }

      updateScheduledTaskStatement.run({
        id,
        schedule: hasOwnProperty(update, "schedule")
          ? update.schedule ?? existing.schedule
          : existing.schedule,
        prompt: hasOwnProperty(update, "prompt")
          ? update.prompt ?? existing.prompt
          : existing.prompt,
        enabled: hasOwnProperty(update, "enabled")
          ? (update.enabled ? 1 : 0)
          : existing.enabled,
        max_output_tokens: hasOwnProperty(update, "maxOutputTokens")
          ? update.maxOutputTokens ?? existing.max_output_tokens
          : existing.max_output_tokens,
        telegram_chat_id: hasOwnProperty(update, "telegramChatId")
          ? update.telegramChatId ?? null
          : existing.telegram_chat_id,
        run_once: hasOwnProperty(update, "runOnce")
          ? (update.runOnce ? 1 : 0)
          : existing.run_once,
        next_run_at: hasOwnProperty(update, "nextRunAt")
          ? update.nextRunAt ?? null
          : existing.next_run_at,
        is_running: hasOwnProperty(update, "isRunning")
          ? (update.isRunning ? 1 : 0)
          : existing.is_running,
        last_started_at: hasOwnProperty(update, "lastStartedAt")
          ? update.lastStartedAt ?? null
          : existing.last_started_at,
        last_finished_at: hasOwnProperty(update, "lastFinishedAt")
          ? update.lastFinishedAt ?? null
          : existing.last_finished_at,
        last_duration_ms: hasOwnProperty(update, "lastDurationMs")
          ? update.lastDurationMs ?? null
          : existing.last_duration_ms,
        last_error: hasOwnProperty(update, "lastError")
          ? update.lastError ?? null
          : existing.last_error,
        last_output_preview: hasOwnProperty(update, "lastOutputPreview")
          ? update.lastOutputPreview ?? null
          : existing.last_output_preview,
      });

      const row = getScheduledTaskByIdStatement.get(id) as
        | ScheduledTaskRow
        | undefined;
      if (!row) {
        throw new Error(`Updated scheduled task ${id} could not be read back from SQLite`);
      }

      return mapScheduledTaskRow(row);
    },

    listScheduledTasks() {
      return (listScheduledTasksStatement.all() as ScheduledTaskRow[]).map(
        mapScheduledTaskRow,
      );
    },

    listDueScheduledTasks(nowIso, limit = 10) {
      return (listDueScheduledTasksStatement.all({
        now_iso: nowIso,
        limit,
      }) as ScheduledTaskRow[]).map(mapScheduledTaskRow);
    },

    markScheduledTaskRunning(id, startedAt) {
      const result = markScheduledTaskRunningStatement.run({
        id,
        started_at: startedAt,
      });
      if (result.changes === 0) {
        return null;
      }

      const row = getScheduledTaskByIdStatement.get(id) as
        | ScheduledTaskRow
        | undefined;
      return row ? mapScheduledTaskRow(row) : null;
    },

    releaseStaleScheduledTasks(staleBeforeIso) {
      const result = releaseStaleScheduledTasksStatement.run(staleBeforeIso);
      return result.changes;
    },

    insertScheduledTaskRun(run) {
      const result = insertScheduledTaskRunStatement.run({
        task_id: run.taskId,
        task_name: run.taskName,
        status: run.status,
        started_at: run.startedAt,
        finished_at: run.finishedAt,
        duration_ms: run.durationMs ?? null,
        output_text: run.outputText ?? null,
        error_text: run.errorText ?? null,
      });

      const row = getScheduledTaskRunByIdStatement.get(Number(result.lastInsertRowid)) as
        | ScheduledTaskRunRow
        | undefined;
      if (!row) {
        throw new Error("Inserted scheduled task run could not be read back from SQLite");
      }

      return mapScheduledTaskRunRow(row);
    },

    listScheduledTaskRuns(limit = 50) {
      return (listScheduledTaskRunsStatement.all(limit) as ScheduledTaskRunRow[]).map(
        mapScheduledTaskRunRow,
      );
    },

    close() {
      db.close();
    },
  };
}
