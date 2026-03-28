import {
  buildReminderDeliveryText,
  parseReminderCreateRequest,
  type ReminderCreateRequest,
} from "./reminders.js";

export type SkillName =
  | "fs_read"
  | "fs_write"
  | "shell_exec"
  | "reminder_create"
  | "reminder_list"
  | "reminder_cancel";

export type FsReadSkillRequest = {
  skillName: "fs_read";
  path: string;
};

export type FsWriteSkillRequest = {
  skillName: "fs_write";
  path: string;
  content: string;
};

export type ShellExecSkillRequest = {
  skillName: "shell_exec";
  command: string;
};

export type ReminderListRequest = {
  actionName: "reminder_list";
};

export type ReminderCancelRequest =
  | {
      actionName: "reminder_cancel";
      cancelMode: "id";
      reminderId: number;
    }
  | {
      actionName: "reminder_cancel";
      cancelMode: "text";
      reminderText: string;
    };

export type SkillExecutionRequest =
  | FsReadSkillRequest
  | FsWriteSkillRequest
  | ShellExecSkillRequest;

export type SkillControlRequest =
  | {
      controlName: "shell_confirm";
      token: string;
    }
  | {
      controlName: "shell_cancel";
      token: string;
    };

export type ParsedSkillRequest =
  | SkillExecutionRequest
  | SkillControlRequest
  | ReminderCreateRequest
  | ReminderListRequest
  | ReminderCancelRequest;

export type SkillExecutionResult = {
  success: boolean;
  output: string | null;
  error: string | null;
  meta: {
    skillName: SkillName;
    targetPath: string;
    durationMs: number;
    resultSize: number;
  };
};

function normalizeCommand(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function parseNaturalWritePath(leftPart: string): string | null {
  const candidates = [
    /^save\s+file\s+name\s+as\s+(.+)$/i,
    /^save\s+file\s+as\s+(.+)$/i,
    /^save\s+file\s+named\s+(.+)$/i,
    /^save\s+file\s+(.+)$/i,
    /^create\s+file\s+named\s+(.+)$/i,
    /^create\s+file\s+(.+)$/i,
    /^write\s+file\s+(.+)$/i,
  ];

  for (const pattern of candidates) {
    const match = leftPart.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const path = match[1].trim();
    if (path) {
      return path;
    }
  }

  return null;
}

function parseNaturalWriteRequest(normalized: string): FsWriteSkillRequest | null {
  const match = normalized.match(/^(.*?)(?:\bcontent\s*(?:is|:)\s*)([\s\S]+)$/i);
  if (!match) {
    return null;
  }

  const leftPart = match[1]?.trim() ?? "";
  const content = match[2] ?? "";
  const targetPath = parseNaturalWritePath(leftPart);
  if (!targetPath) {
    return null;
  }

  return {
    skillName: "fs_write",
    path: targetPath,
    content,
  };
}

function parseNaturalReadRequest(normalized: string): FsReadSkillRequest | null {
  const readPatterns = [
    /^(?:please\s+)?(?:(?:can|could)\s+you\s+)?read\s+(?:the\s+)?file\s+(.+)$/i,
    /^(?:please\s+)?(?:(?:can|could)\s+you\s+)?open\s+(?:the\s+)?file\s+(.+)$/i,
    /^(?:please\s+)?(?:(?:can|could)\s+you\s+)?show\s+(?:the\s+)?file\s+(.+)$/i,
  ];

  for (const pattern of readPatterns) {
    const match = normalized.match(pattern);
    const targetPath = match?.[1]?.trim();
    if (!targetPath) {
      continue;
    }

    return {
      skillName: "fs_read",
      path: targetPath.replace(/[.?!]+$/g, "").trim(),
    };
  }

  return null;
}

function parseNaturalShellRequest(normalized: string): ShellExecSkillRequest | null {
  const patterns = [
    /^\/?shell_exec\s+([^\n]+)$/i,
    /^(?:please\s+)?run\s+command\s+(.+)$/i,
    /^(?:please\s+)?execute\s+command\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const command = match?.[1]?.trim();
    if (!command) {
      continue;
    }

    return {
      skillName: "shell_exec",
      command,
    };
  }

  return null;
}

function parseSkillControlRequest(normalized: string): SkillControlRequest | null {
  const confirmMatch = normalized.match(/^\/?(?:confirm(?:_shell)?|confirm\s+shell)\s+([a-z0-9-]{4,})$/i);
  if (confirmMatch?.[1]) {
    return {
      controlName: "shell_confirm",
      token: confirmMatch[1],
    };
  }

  const cancelMatch = normalized.match(/^\/?(?:cancel(?:_shell)?|cancel\s+shell)\s+([a-z0-9-]{4,})$/i);
  if (cancelMatch?.[1]) {
    return {
      controlName: "shell_cancel",
      token: cancelMatch[1],
    };
  }

  return null;
}

function parseReminderManagementRequest(
  normalized: string,
): ReminderListRequest | ReminderCancelRequest | null {
  if (
    /^\/?list_reminders$/i.test(normalized) ||
    /^list(?:\s+(?:my|the))?\s+rem(?:ind|aind)ers?$/i.test(normalized)
  ) {
    return {
      actionName: "reminder_list",
    };
  }

  const cancelByIdMatch = normalized.match(/^\/?cancel_reminder\s+(\d+)$/i) ??
    normalized.match(/^(?:please\s+)?cancel\s+rem(?:ind|aind)er\s+(\d+)$/i);
  if (cancelByIdMatch?.[1]) {
    const reminderId = Number.parseInt(cancelByIdMatch[1], 10);
    if (Number.isInteger(reminderId) && reminderId > 0) {
      return {
        actionName: "reminder_cancel",
        cancelMode: "id",
        reminderId,
      };
    }
  }

  const cancelByTextMatch = normalized.match(
    /^(?:please\s+)?(?:cancel|stop|disable)\s+rem(?:ind|aind)er\s+(.+)$/i,
  );
  const reminderText = cancelByTextMatch?.[1]
    ?.trim()
    .replace(/[.?!]+$/g, "")
    .trim();
  if (reminderText) {
    return {
      actionName: "reminder_cancel",
      cancelMode: "text",
      reminderText: buildReminderDeliveryText(reminderText),
    };
  }

  return null;
}

export function isSkillExecutionRequest(
  request: ParsedSkillRequest,
): request is SkillExecutionRequest {
  return "skillName" in request;
}

export function isReminderCreateRequest(
  request: ParsedSkillRequest,
): request is ReminderCreateRequest {
  return "actionName" in request && request.actionName === "reminder_create";
}

export function isReminderListRequest(
  request: ParsedSkillRequest,
): request is ReminderListRequest {
  return "actionName" in request && request.actionName === "reminder_list";
}

export function isReminderCancelRequest(
  request: ParsedSkillRequest,
): request is ReminderCancelRequest {
  return "actionName" in request && request.actionName === "reminder_cancel";
}

export function parseSkillRequest(text: string): ParsedSkillRequest | null {
  const normalized = normalizeCommand(text);
  if (!normalized) {
    return null;
  }

  const controlRequest = parseSkillControlRequest(normalized);
  if (controlRequest) {
    return controlRequest;
  }

  const reminderManagementRequest = parseReminderManagementRequest(normalized);
  if (reminderManagementRequest) {
    return reminderManagementRequest;
  }

  const reminderRequest = parseReminderCreateRequest(normalized);
  if (reminderRequest) {
    return reminderRequest;
  }

  const readMatch = normalized.match(/^\/?fs_read\s+([^\n]+)$/i);
  if (readMatch) {
    const targetPath = readMatch[1]?.trim();
    if (!targetPath) {
      return null;
    }

    return {
      skillName: "fs_read",
      path: targetPath,
    };
  }

  const writeMatch = normalized.match(/^\/?fs_write\s+([^\n]+)\n([\s\S]*)$/i);
  if (writeMatch) {
    const targetPath = writeMatch[1]?.trim();
    if (!targetPath) {
      return null;
    }

    return {
      skillName: "fs_write",
      path: targetPath,
      content: writeMatch[2] ?? "",
    };
  }

  const shellRequest = parseNaturalShellRequest(normalized);
  if (shellRequest) {
    return shellRequest;
  }

  const naturalWriteRequest = parseNaturalWriteRequest(normalized);
  if (naturalWriteRequest) {
    return naturalWriteRequest;
  }

  const naturalReadRequest = parseNaturalReadRequest(normalized);
  if (naturalReadRequest) {
    return naturalReadRequest;
  }

  return null;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 19)).trimEnd()}\n[output truncated]`;
}

export function formatSkillResultForTelegram(
  result: SkillExecutionResult,
  maxChars = 4000,
): string {
  if (result.meta.skillName.startsWith("reminder_")) {
    const reminderReply = result.success
      ? (result.output?.trim() || "Reminder has been set.")
      : (result.error?.trim() || "Could not set the reminder.");

    return truncateText(reminderReply, maxChars);
  }

  const baseLines = [
    `success: ${result.success ? "true" : "false"}`,
    result.output === null
      ? "output: null"
      : `output:\n${truncateText(result.output, Math.min(3200, maxChars - 80))}`,
    `error: ${result.error ?? "null"}`,
  ];
  const composed = baseLines.join("\n");

  if (composed.length <= maxChars) {
    return composed;
  }

  return `${composed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
