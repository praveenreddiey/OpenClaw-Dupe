import type { FastifyBaseLogger } from "fastify";
import { getNextCronOccurrence } from "./cron.js";
import type { AppConfig, ScheduledTaskConfig } from "./config.js";
import type { MessageStore, ScheduledTaskRecord } from "./db.js";
import type { LlmClient, LlmMessage } from "./llm.js";
import type { MessageAdapter } from "./messages.js";
import { decodeStaticReminderPrompt } from "./reminders.js";

type SchedulerRateLimiter = {
  allow(): boolean;
};

export type TaskScheduler = {
  start(): void;
  stop(): Promise<void>;
};

type CreateTaskSchedulerOptions = {
  config: AppConfig["scheduler"];
  llmMaxResponseTokens: number;
  logger: FastifyBaseLogger;
  llmClient: LlmClient;
  messageAdapter: MessageAdapter;
  messageStore: MessageStore;
};

function currentTimestamp(): string {
  return new Date().toISOString();
}

function createRateLimiter(windowMs: number, maxRuns: number): SchedulerRateLimiter {
  const hits: number[] = [];

  return {
    allow() {
      const now = Date.now();
      const windowStart = now - windowMs;

      while (hits.length > 0 && (hits[0] ?? 0) <= windowStart) {
        hits.shift();
      }

      if (hits.length >= maxRuns) {
        return false;
      }

      hits.push(now);
      return true;
    },
  };
}

function truncatePreview(text: string, maxChars = 400): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function parseStoredMessageId(messageId: string | null): number | null {
  if (!messageId) {
    return null;
  }

  const parsed = Number(messageId);
  return Number.isInteger(parsed) ? parsed : null;
}

function limitTelegramText(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return "(no output)";
  }

  if (normalized.length <= 4000) {
    return normalized;
  }

  return `${normalized.slice(0, 3997)}...`;
}

function resolveTaskOutput(task: ScheduledTaskRecord, rawText: string): {
  text: string;
  usedFallback: boolean;
} {
  const trimmed = rawText.trim();
  if (trimmed) {
    return {
      text: trimmed,
      usedFallback: false,
    };
  }

  return {
    text: `Scheduled task ${task.name} completed successfully.`,
    usedFallback: true,
  };
}

export function buildScheduledTaskMessages(taskPrompt: string): LlmMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are Claw Dupe's scheduled task worker.",
        "Complete the task directly.",
        "Return plain text only.",
        "If the task cannot be completed, explain the failure briefly and concretely.",
      ].join(" "),
    },
    {
      role: "user",
      content: taskPrompt,
    },
  ];
}

function getNextRunAt(task: ScheduledTaskRecord): string {
  return getNextCronOccurrence(task.schedule, new Date()).toISOString();
}

function getRetryRunAt(task: ScheduledTaskRecord): string {
  if (task.runOnce) {
    return new Date(Date.now() + 60_000).toISOString();
  }

  return getNextRunAt(task);
}

function syncConfiguredTask(
  messageStore: MessageStore,
  task: ScheduledTaskConfig,
): ScheduledTaskRecord {
  const existing = messageStore.getScheduledTaskByName(task.name);
  const nextRunAt = existing && existing.schedule === task.schedule
    ? existing.nextRunAt ?? getNextCronOccurrence(task.schedule, new Date()).toISOString()
    : getNextCronOccurrence(task.schedule, new Date()).toISOString();

  return messageStore.upsertScheduledTask({
    name: task.name,
    schedule: task.schedule,
    prompt: task.prompt,
    enabled: task.enabled,
    maxOutputTokens: task.maxOutputTokens,
    telegramChatId: task.telegramChatId ?? null,
    runOnce: task.runOnce ?? false,
    nextRunAt,
  });
}

export function createTaskScheduler({
  config,
  llmMaxResponseTokens,
  logger,
  llmClient,
  messageAdapter,
  messageStore,
}: CreateTaskSchedulerOptions): TaskScheduler {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let tickInFlight = false;
  const rateLimiter = createRateLimiter(
    config.rateLimitWindowMs,
    config.rateLimitMaxRuns,
  );

  const scheduleNextTick = () => {
    if (stopped) {
      return;
    }

    timer = setTimeout(() => {
      void tick();
    }, config.pollIntervalMs);
  };

  const recordRecoveredStaleRuns = () => {
    const staleBefore = new Date(Date.now() - config.runTimeoutMs).toISOString();
    const releasedCount = messageStore.releaseStaleScheduledTasks(staleBefore);
    if (releasedCount > 0) {
      logger.warn(
        { releasedCount, staleBefore },
        "released stale scheduled task locks after restart or timeout",
      );
    }
  };

  const runTask = async (task: ScheduledTaskRecord) => {
    const startedAt = currentTimestamp();
    const claimedTask = messageStore.markScheduledTaskRunning(task.id, startedAt);
    if (!claimedTask) {
      return;
    }

    if (!rateLimiter.allow()) {
      const finishedAt = currentTimestamp();
      const errorText = "Scheduler rate limit exceeded for this window";
      const nextRunAt = getRetryRunAt(claimedTask);
      messageStore.updateScheduledTask(claimedTask.id, {
        enabled: claimedTask.enabled,
        isRunning: false,
        nextRunAt,
        lastFinishedAt: finishedAt,
        lastDurationMs: 0,
        lastError: errorText,
        lastOutputPreview: null,
      });
      messageStore.insertScheduledTaskRun({
        taskId: claimedTask.id,
        taskName: claimedTask.name,
        status: "rate_limited",
        startedAt,
        finishedAt,
        durationMs: 0,
        outputText: null,
        errorText,
      });
      logger.warn(
        { taskId: claimedTask.id, taskName: claimedTask.name },
        "skipped scheduled task because of the scheduler rate limit",
      );
      return;
    }

    const startedAtMs = Date.now();
    let outputText: string | null = null;
    try {
      const staticReminderText = decodeStaticReminderPrompt(claimedTask.prompt);
      if (staticReminderText) {
        outputText = staticReminderText;
      } else {
        const messages = buildScheduledTaskMessages(claimedTask.prompt);
        const result = await llmClient.generate({
          messages,
          maxOutputTokens: claimedTask.maxOutputTokens || llmMaxResponseTokens,
          timeoutMs: config.runTimeoutMs,
        });
        const resolvedOutput = resolveTaskOutput(claimedTask, result.text);
        outputText = resolvedOutput.text;

        if (resolvedOutput.usedFallback) {
          logger.warn(
            {
              taskId: claimedTask.id,
              taskName: claimedTask.name,
            },
            "scheduled task produced empty output; using fallback text",
          );
        }
      }

      if (claimedTask.telegramChatId) {
        const deliveredText = limitTelegramText(outputText);
        const delivery = await messageAdapter.sendMessage({
          chatId: claimedTask.telegramChatId,
          text: deliveredText,
        });

        messageStore.insertMessage({
          chatId: claimedTask.telegramChatId,
          userId: null,
          direction: "outgoing",
          status: delivery.delivered ? "processed" : "failed",
          text: deliveredText,
          telegramMessageId: parseStoredMessageId(delivery.messageId),
          messageTimestamp: delivery.timestamp,
          payloadJson: delivery.payloadJson,
        });
      }

      const finishedAt = currentTimestamp();
      const durationMs = Date.now() - startedAtMs;
      const nextRunAt = claimedTask.runOnce ? null : getNextRunAt(claimedTask);

      messageStore.updateScheduledTask(claimedTask.id, {
        enabled: claimedTask.runOnce ? false : claimedTask.enabled,
        isRunning: false,
        nextRunAt,
        lastFinishedAt: finishedAt,
        lastDurationMs: durationMs,
        lastError: null,
        lastOutputPreview: truncatePreview(outputText),
      });
      messageStore.insertScheduledTaskRun({
        taskId: claimedTask.id,
        taskName: claimedTask.name,
        status: "completed",
        startedAt,
        finishedAt,
        durationMs,
        outputText,
        errorText: null,
      });

      logger.info(
        {
          taskId: claimedTask.id,
          taskName: claimedTask.name,
          durationMs,
          usedStaticOutput: Boolean(staticReminderText),
          sentToTelegram: Boolean(claimedTask.telegramChatId),
          resultSize: Buffer.byteLength(outputText, "utf8"),
        },
        "completed scheduled task run",
      );
    } catch (error) {
      const finishedAt = currentTimestamp();
      const durationMs = Date.now() - startedAtMs;
      const errorText = error instanceof Error ? error.message : String(error);
      const nextRunAt = getRetryRunAt(claimedTask);

      messageStore.updateScheduledTask(claimedTask.id, {
        enabled: claimedTask.enabled,
        isRunning: false,
        nextRunAt,
        lastFinishedAt: finishedAt,
        lastDurationMs: durationMs,
        lastError: errorText,
        lastOutputPreview: outputText ? truncatePreview(outputText) : null,
      });
      messageStore.insertScheduledTaskRun({
        taskId: claimedTask.id,
        taskName: claimedTask.name,
        status: "failed",
        startedAt,
        finishedAt,
        durationMs,
        outputText,
        errorText,
      });

      logger.error(
        {
          err: error,
          taskId: claimedTask.id,
          taskName: claimedTask.name,
          durationMs,
          usedStaticOutput: Boolean(decodeStaticReminderPrompt(claimedTask.prompt)),
          sentToTelegram: Boolean(claimedTask.telegramChatId),
        },
        "scheduled task run failed",
      );
    }
  };

  const tick = async () => {
    if (stopped || tickInFlight) {
      return;
    }

    tickInFlight = true;
    try {
      const dueTasks = messageStore.listDueScheduledTasks(currentTimestamp(), 10);
      for (const task of dueTasks) {
        await runTask(task);
      }
    } finally {
      tickInFlight = false;
      scheduleNextTick();
    }
  };

  return {
    start() {
      for (const task of config.tasks) {
        syncConfiguredTask(messageStore, task);
      }
      recordRecoveredStaleRuns();
      scheduleNextTick();
    },

    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
