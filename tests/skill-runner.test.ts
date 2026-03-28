import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { parseReminderCreateRequest } from "../src/reminders.js";
import { createSkillRunner, type SkillRunnerConfig } from "../src/skill-runner.js";
import { formatSkillResultForTelegram, parseSkillRequest } from "../src/skills.js";

function createTempWorkspace(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "claw-dupe-skills-"));
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function createTestConfig(): SkillRunnerConfig {
  return {
    enabled: true,
    timeoutMs: 1000,
    maxOldGenerationSizeMb: 32,
    maxReadBytes: 1024,
    maxWriteBytes: 1024,
    allowedPaths: ["./"],
    blockedPaths: ["./.env"],
    shellEnabled: true,
    shellWorkingDirectory: "./",
    shellMaxOutputBytes: 4096,
    shellAllowlist: [
      {
        command: "git status --short",
        requiresConfirmation: false,
      },
      {
        command: "npm run build",
        requiresConfirmation: true,
      },
    ],
  };
}

test("parseSkillRequest understands fs_read and fs_write commands", () => {
  assert.deepEqual(parseSkillRequest("/fs_read README.md"), {
    skillName: "fs_read",
    path: "README.md",
  });
  assert.deepEqual(parseSkillRequest("/fs_write docs/note.md\nhello"), {
    skillName: "fs_write",
    path: "docs/note.md",
    content: "hello",
  });
});

test("parseSkillRequest understands shell commands and shell confirmation controls", () => {
  assert.deepEqual(
    parseSkillRequest("/shell_exec git status --short"),
    {
      skillName: "shell_exec",
      command: "git status --short",
    },
  );

  assert.deepEqual(
    parseSkillRequest("run command npm test"),
    {
      skillName: "shell_exec",
      command: "npm test",
    },
  );

  assert.deepEqual(
    parseSkillRequest("/confirm_shell abc123"),
    {
      controlName: "shell_confirm",
      token: "abc123",
    },
  );

  assert.deepEqual(
    parseSkillRequest("/cancel_shell abc123"),
    {
      controlName: "shell_cancel",
      token: "abc123",
    },
  );
});

test("parseSkillRequest understands natural-language reminder requests", () => {
  assert.deepEqual(
    parseSkillRequest("remind me every 10 minutes to drink water"),
    {
      actionName: "reminder_create",
      scheduleMode: "recurring",
      intervalMinutes: 10,
      reminderText: "drink water",
    },
  );

  assert.deepEqual(
    parseSkillRequest("Remind me every 2 mins to stand up."),
    {
      actionName: "reminder_create",
      scheduleMode: "recurring",
      intervalMinutes: 2,
      reminderText: "stand up",
    },
  );

  assert.deepEqual(
    parseSkillRequest("set a remainder to drink water every 2 minutes"),
    {
      actionName: "reminder_create",
      scheduleMode: "recurring",
      intervalMinutes: 2,
      reminderText: "drink water",
    },
  );

  const firstOneTime = parseSkillRequest("remind me to send email in 1 minute");
  assert.ok(firstOneTime && "actionName" in firstOneTime);
  assert.equal(firstOneTime.actionName, "reminder_create");
  assert.equal(firstOneTime.scheduleMode, "once");
  assert.equal(firstOneTime.reminderText, "send email");
  assert.equal(firstOneTime.timingText, "in 1 minute");
  assert.match(firstOneTime.runAtIso, /^\d{4}-\d{2}-\d{2}T/);

  const secondOneTime = parseSkillRequest("remind me in 5 minutes to stretch");
  assert.ok(secondOneTime && "actionName" in secondOneTime);
  assert.equal(secondOneTime.actionName, "reminder_create");
  assert.equal(secondOneTime.scheduleMode, "once");
  assert.equal(secondOneTime.reminderText, "stretch");
  assert.equal(secondOneTime.timingText, "in 5 minutes");
  assert.match(secondOneTime.runAtIso, /^\d{4}-\d{2}-\d{2}T/);

  const typoClockReminder = parseSkillRequest(
    "set a remainder at 2:36pm IST to go to shopping",
  );
  assert.ok(typoClockReminder && "actionName" in typoClockReminder);
  assert.equal(typoClockReminder.actionName, "reminder_create");
  assert.equal(typoClockReminder.scheduleMode, "once");
  assert.equal(typoClockReminder.reminderText, "go to shopping");
  assert.equal(typoClockReminder.timingText, "at 2:36 PM");
  assert.match(typoClockReminder.runAtIso, /^\d{4}-\d{2}-\d{2}T/);

  const definiteArticleReminder = parseSkillRequest(
    "set the remainder at 2:54pm to go shopping",
  );
  assert.ok(definiteArticleReminder && "actionName" in definiteArticleReminder);
  assert.equal(definiteArticleReminder.actionName, "reminder_create");
  assert.equal(definiteArticleReminder.scheduleMode, "once");
  assert.equal(definiteArticleReminder.reminderText, "go shopping");
  assert.equal(definiteArticleReminder.timingText, "at 2:54 PM");
  assert.match(definiteArticleReminder.runAtIso, /^\d{4}-\d{2}-\d{2}T/);

  assert.deepEqual(parseSkillRequest("list the remainders"), {
    actionName: "reminder_list",
  });

  assert.deepEqual(parseSkillRequest("/list_reminders"), {
    actionName: "reminder_list",
  });

  assert.deepEqual(parseSkillRequest("cancel reminder send email"), {
    actionName: "reminder_cancel",
    cancelMode: "text",
    reminderText: "Reminder: send email",
  });

  assert.deepEqual(parseSkillRequest("/cancel_reminder 42"), {
    actionName: "reminder_cancel",
    cancelMode: "id",
    reminderId: 42,
  });
});

test("parseReminderCreateRequest understands exact clock-time reminders", () => {
  const morningNow = new Date("2026-03-28T08:30:00+05:30");
  const sameDay = parseReminderCreateRequest(
    "remind me at 2pm to send email",
    morningNow,
  );

  assert.deepEqual(sameDay, {
    actionName: "reminder_create",
    scheduleMode: "once",
    reminderText: "send email",
    runAtIso: new Date("2026-03-28T14:00:00+05:30").toISOString(),
    timingText: "at 2:00 PM",
  });

  const eveningNow = new Date("2026-03-28T20:30:00+05:30");
  const rollover = parseReminderCreateRequest(
    "remind me to send email at 2pm",
    eveningNow,
  );

  assert.deepEqual(rollover, {
    actionName: "reminder_create",
    scheduleMode: "once",
    reminderText: "send email",
    runAtIso: new Date("2026-03-29T14:00:00+05:30").toISOString(),
    timingText: "at 2:00 PM",
  });

  const tomorrowReminder = parseReminderCreateRequest(
    "remind me tomorrow at 9:15am to join standup",
    morningNow,
  );

  assert.deepEqual(tomorrowReminder, {
    actionName: "reminder_create",
    scheduleMode: "once",
    reminderText: "join standup",
    runAtIso: new Date("2026-03-29T09:15:00+05:30").toISOString(),
    timingText: "tomorrow at 9:15 AM",
  });

  const exactDateReminder = parseReminderCreateRequest(
    "remind me on 31 March at 2pm to send email",
    morningNow,
  );

  assert.deepEqual(exactDateReminder, {
    actionName: "reminder_create",
    scheduleMode: "once",
    reminderText: "send email",
    runAtIso: new Date("2026-03-31T14:00:00+05:30").toISOString(),
    timingText: "on 31 March at 2:00 PM",
  });

  const nextYearReminder = parseReminderCreateRequest(
    "remind me on 27 March at 2pm to send email",
    morningNow,
  );

  assert.deepEqual(nextYearReminder, {
    actionName: "reminder_create",
    scheduleMode: "once",
    reminderText: "send email",
    runAtIso: new Date("2027-03-27T14:00:00+05:30").toISOString(),
    timingText: "on 27 March at 2:00 PM",
  });

  const explicitYearReminder = parseReminderCreateRequest(
    "remind me to pay rent on 5 April 2099 at 9am",
    morningNow,
  );

  assert.deepEqual(explicitYearReminder, {
    actionName: "reminder_create",
    scheduleMode: "once",
    reminderText: "pay rent",
    runAtIso: new Date("2099-04-05T09:00:00+05:30").toISOString(),
    timingText: "on 5 April 2099 at 9:00 AM",
  });
});

test("parseSkillRequest understands natural-language save requests", () => {
  assert.deepEqual(
    parseSkillRequest("Save file name as name.txt Content is hi praveen"),
    {
      skillName: "fs_write",
      path: "name.txt",
      content: "hi praveen",
    },
  );

  assert.deepEqual(
    parseSkillRequest("create file notes/today.txt content: done"),
    {
      skillName: "fs_write",
      path: "notes/today.txt",
      content: "done",
    },
  );
});

test("parseSkillRequest understands natural-language read requests", () => {
  assert.deepEqual(
    parseSkillRequest("Read file name.txt"),
    {
      skillName: "fs_read",
      path: "name.txt",
    },
  );

  assert.deepEqual(
    parseSkillRequest("Can you show the file docs/todo.md?"),
    {
      skillName: "fs_read",
      path: "docs/todo.md",
    },
  );
});

test("createSkillRunner reads allowed files in a worker thread", async () => {
  const temp = createTempWorkspace();
  writeFileSync(path.join(temp.directory, "docs.txt"), "hello from worker", "utf8");

  try {
    const runner = createSkillRunner(createTestConfig(), {
      cwd: temp.directory,
    });
    const result = await runner.execute({
      skillName: "fs_read",
      path: "docs.txt",
    });

    assert.equal(result.success, true);
    assert.equal(result.output, "hello from worker");
    assert.equal(result.error, null);
    assert.equal(result.meta.targetPath, "docs.txt");
    assert.ok(result.meta.durationMs >= 0);
  } finally {
    temp.cleanup();
  }
});

test("createSkillRunner writes allowed files in a worker thread", async () => {
  const temp = createTempWorkspace();

  try {
    const runner = createSkillRunner(createTestConfig(), {
      cwd: temp.directory,
    });
    const result = await runner.execute({
      skillName: "fs_write",
      path: "notes/out.txt",
      content: "saved by skill",
    });

    assert.equal(result.success, true);
    assert.equal(result.error, null);
    assert.match(result.output ?? "", /Wrote 14 bytes to notes\/out\.txt\./);

    const written = await runner.execute({
      skillName: "fs_read",
      path: "notes/out.txt",
    });
    assert.equal(written.output, "saved by skill");
  } finally {
    temp.cleanup();
  }
});

test("createSkillRunner rejects blocked or out-of-scope paths", async () => {
  const temp = createTempWorkspace();
  writeFileSync(path.join(temp.directory, ".env"), "SECRET=value", "utf8");
  writeFileSync(path.join(temp.directory, "outside.txt"), "nope", "utf8");

  try {
    const scopedRunner = createSkillRunner({
      ...createTestConfig(),
      allowedPaths: ["./safe"],
      blockedPaths: ["./.env"],
    }, {
      cwd: temp.directory,
    });

    const blockedResult = await createSkillRunner(createTestConfig(), {
      cwd: temp.directory,
    }).execute({
      skillName: "fs_read",
      path: ".env",
    });
    assert.equal(blockedResult.success, false);
    assert.match(blockedResult.error ?? "", /blocked for safety/i);

    const outOfScopeResult = await scopedRunner.execute({
      skillName: "fs_read",
      path: "outside.txt",
    });
    assert.equal(outOfScopeResult.success, false);
    assert.match(outOfScopeResult.error ?? "", /outside the skill allowlist/i);
  } finally {
    temp.cleanup();
  }
});

test("createSkillRunner enforces read limits", async () => {
  const temp = createTempWorkspace();
  writeFileSync(path.join(temp.directory, "large.txt"), "x".repeat(2048), "utf8");

  try {
    const runner = createSkillRunner(createTestConfig(), {
      cwd: temp.directory,
    });
    const result = await runner.execute({
      skillName: "fs_read",
      path: "large.txt",
    });

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /Read limit exceeded/i);
  } finally {
    temp.cleanup();
  }
});

test("createSkillRunner terminates slow workers on timeout", async () => {
  class SlowWorker extends EventEmitter {
    terminateCalled = false;

    async terminate(): Promise<number> {
      this.terminateCalled = true;
      return 1;
    }
  }

  const slowWorker = new SlowWorker();
  const runner = createSkillRunner({
    ...createTestConfig(),
    timeoutMs: 50,
  }, {
    createWorker: (() => slowWorker) as never,
  });
  const result = await runner.execute({
    skillName: "fs_read",
    path: "README.md",
  });

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /timed out/i);
  assert.equal(slowWorker.terminateCalled, true);
});

test("formatSkillResultForTelegram preserves the standardized shape", () => {
  const formatted = formatSkillResultForTelegram({
    success: true,
    output: "file contents",
    error: null,
    meta: {
      skillName: "fs_read",
      targetPath: "README.md",
      durationMs: 2,
      resultSize: 13,
    },
  });

  assert.match(formatted, /^success: true/m);
  assert.match(formatted, /^output:/m);
  assert.match(formatted, /^error: null/m);
});

test("formatSkillResultForTelegram uses a human-friendly reminder confirmation", () => {
  const formatted = formatSkillResultForTelegram({
    success: true,
    output: "Reminder has been set.\nIt will repeat every 1 minute.",
    error: null,
    meta: {
      skillName: "reminder_create",
      targetPath: "reminder-chat-123-send-email",
      durationMs: 0,
      resultSize: 52,
    },
  });

  assert.equal(
    formatted,
    "Reminder has been set.\nIt will repeat every 1 minute.",
  );
  assert.doesNotMatch(formatted, /^success:/m);

  assert.equal(
    formatSkillResultForTelegram({
      success: true,
      output: "Your active reminders:\n1. [7] Reminder: send email",
      error: null,
      meta: {
        skillName: "reminder_list",
        targetPath: "chat-123",
        durationMs: 0,
        resultSize: 50,
      },
    }),
    "Your active reminders:\n1. [7] Reminder: send email",
  );
});
