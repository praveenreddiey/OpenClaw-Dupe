export type RecurringReminderCreateRequest = {
  actionName: "reminder_create";
  scheduleMode: "recurring";
  intervalMinutes: number;
  reminderText: string;
};

export type OneTimeReminderCreateRequest = {
  actionName: "reminder_create";
  scheduleMode: "once";
  reminderText: string;
  runAtIso: string;
  timingText: string;
};

export type ReminderCreateRequest =
  | RecurringReminderCreateRequest
  | OneTimeReminderCreateRequest;

const STATIC_REMINDER_PREFIX = "[[static-reminder]] ";

function normalizeReminderText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.?!]+$/g, "")
    .trim();
}

function buildReminderSlug(reminderText: string): string {
  const normalized = normalizeReminderText(reminderText).toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug || "message";
}

function buildReminderChecksum(reminderText: string): string {
  let checksum = 7;

  for (const character of normalizeReminderText(reminderText).toLowerCase()) {
    checksum = ((checksum * 31) + character.charCodeAt(0)) >>> 0;
  }

  return checksum.toString(36);
}

type ParsedClockTime = {
  hour: number;
  minute: number;
  label: string;
};

type ParsedCalendarDate = {
  day: number;
  monthIndex: number;
  explicitYear: boolean;
  year: number | null;
  label: string;
};

const MONTH_NAME_LOOKUP = new Map<string, number>([
  ["jan", 0],
  ["january", 0],
  ["feb", 1],
  ["february", 1],
  ["mar", 2],
  ["march", 2],
  ["apr", 3],
  ["april", 3],
  ["may", 4],
  ["jun", 5],
  ["june", 5],
  ["jul", 6],
  ["july", 6],
  ["aug", 7],
  ["august", 7],
  ["sep", 8],
  ["sept", 8],
  ["september", 8],
  ["oct", 9],
  ["october", 9],
  ["nov", 10],
  ["november", 10],
  ["dec", 11],
  ["december", 11],
]);

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function normalizeReminderCommand(text: string): string {
  return text
    .trim()
    .replace(
      /^set\s+(?:(?:a|the)\s+)?rem(?:ind|aind)er\s+/i,
      "remind me ",
    );
}

function stripClockTimeZoneSuffix(text: string): string {
  return text.trim().replace(
    /\s+(?:ist|utc|gmt|bst|cet|cest|pst|pdt|est|edt|cst|cdt|mst|mdt)$/i,
    "",
  );
}

function parseCalendarDate(text: string): ParsedCalendarDate | null {
  const normalized = text.trim().replace(/,/g, " ").replace(/\s+/g, " ");
  const patterns = [
    /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?$/i,
    /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) {
      continue;
    }

    const [dayToken, monthToken, yearToken] = pattern === patterns[0]
      ? [match[1], match[2], match[3]]
      : [match[2], match[1], match[3]];
    const day = Number.parseInt(dayToken ?? "", 10);
    const monthIndex = MONTH_NAME_LOOKUP.get((monthToken ?? "").toLowerCase());
    if (!Number.isInteger(day) || day < 1 || day > 31 || monthIndex === undefined) {
      return null;
    }

    let parsedYear: number | null = null;
    if (yearToken) {
      const candidateYear = Number.parseInt(yearToken, 10);
      if (!Number.isInteger(candidateYear) || candidateYear < 1970 || candidateYear > 9999) {
        return null;
      }

      parsedYear = candidateYear;
    }

    return {
      day,
      monthIndex,
      explicitYear: Boolean(yearToken),
      year: parsedYear,
      label: `${day} ${MONTH_LABELS[monthIndex]}${parsedYear === null ? "" : ` ${parsedYear}`}`,
    };
  }

  return null;
}

function formatClockTimeLabel(hour: number, minute: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function parseClockTime(text: string): ParsedClockTime | null {
  const normalized = stripClockTimeZoneSuffix(text).toLowerCase();

  const meridiemMatch = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (meridiemMatch?.[1] && meridiemMatch[3]) {
    const rawHour = Number.parseInt(meridiemMatch[1], 10);
    const minute = Number.parseInt(meridiemMatch[2] ?? "0", 10);
    if (!Number.isInteger(rawHour) || rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) {
      return null;
    }

    const hour = meridiemMatch[3].toLowerCase() === "pm"
      ? (rawHour % 12) + 12
      : rawHour % 12;

    return {
      hour,
      minute,
      label: formatClockTimeLabel(hour, minute),
    };
  }

  const twentyFourHourMatch = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFourHourMatch?.[1] && twentyFourHourMatch[2]) {
    const hour = Number.parseInt(twentyFourHourMatch[1], 10);
    const minute = Number.parseInt(twentyFourHourMatch[2], 10);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return null;
    }

    return {
      hour,
      minute,
      label: formatClockTimeLabel(hour, minute),
    };
  }

  return null;
}

function resolveRunAtForClockTime(
  clockTime: ParsedClockTime,
  now: Date,
  dayOffset: number,
): string {
  const target = new Date(now);
  target.setSeconds(0, 0);
  target.setDate(target.getDate() + dayOffset);
  target.setHours(clockTime.hour, clockTime.minute, 0, 0);

  if (dayOffset === 0 && target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return target.toISOString();
}

function buildCalendarDateTarget(
  calendarDate: ParsedCalendarDate,
  clockTime: ParsedClockTime,
  year: number,
): Date | null {
  const target = new Date();
  target.setSeconds(0, 0);
  target.setFullYear(year, calendarDate.monthIndex, calendarDate.day);
  target.setHours(clockTime.hour, clockTime.minute, 0, 0);

  if (
    target.getFullYear() !== year ||
    target.getMonth() !== calendarDate.monthIndex ||
    target.getDate() !== calendarDate.day
  ) {
    return null;
  }

  return target;
}

function resolveRunAtForCalendarDate(
  calendarDate: ParsedCalendarDate,
  clockTime: ParsedClockTime,
  now: Date,
): string | null {
  if (calendarDate.explicitYear && calendarDate.year !== null) {
    const explicitTarget = buildCalendarDateTarget(
      calendarDate,
      clockTime,
      calendarDate.year,
    );
    if (!explicitTarget || explicitTarget.getTime() <= now.getTime()) {
      return null;
    }

    return explicitTarget.toISOString();
  }

  const currentYearTarget = buildCalendarDateTarget(
    calendarDate,
    clockTime,
    now.getFullYear(),
  );
  if (!currentYearTarget) {
    return null;
  }

  if (currentYearTarget.getTime() > now.getTime()) {
    return currentYearTarget.toISOString();
  }

  const nextYearTarget = buildCalendarDateTarget(
    calendarDate,
    clockTime,
    now.getFullYear() + 1,
  );
  return nextYearTarget?.toISOString() ?? null;
}

export function parseReminderCreateRequest(
  text: string,
  now = new Date(),
): ReminderCreateRequest | null {
  const normalized = normalizeReminderCommand(
    text.replace(/\r\n/g, "\n").trim(),
  );
  const recurringMatch = normalized.match(
    /^remind\s+me\s+every\s+(\d+)\s*(?:minute|minutes|min|mins)\s+to\s+(.+)$/i,
  );

  if (recurringMatch?.[1] && recurringMatch[2]) {
    const intervalMinutes = Number.parseInt(recurringMatch[1], 10);
    const reminderText = normalizeReminderText(recurringMatch[2]);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0 || !reminderText) {
      return null;
    }

    return {
      actionName: "reminder_create",
      scheduleMode: "recurring",
      intervalMinutes,
      reminderText,
    };
  }

  const recurringSuffixMatch = normalized.match(
    /^remind\s+me\s+to\s+(.+?)\s+every\s+(\d+)\s*(?:minute|minutes|min|mins)$/i,
  );

  if (recurringSuffixMatch?.[1] && recurringSuffixMatch[2]) {
    const reminderText = normalizeReminderText(recurringSuffixMatch[1]);
    const intervalMinutes = Number.parseInt(recurringSuffixMatch[2], 10);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0 || !reminderText) {
      return null;
    }

    return {
      actionName: "reminder_create",
      scheduleMode: "recurring",
      intervalMinutes,
      reminderText,
    };
  }

  const oncePatterns = [
    /^remind\s+me\s+in\s+(\d+)\s*(?:minute|minutes|min|mins)\s+to\s+(.+)$/i,
    /^remind\s+me\s+to\s+(.+?)\s+in\s+(\d+)\s*(?:minute|minutes|min|mins)$/i,
  ];

  for (const pattern of oncePatterns) {
    const match = normalized.match(pattern);
    if (!match) {
      continue;
    }

    const intervalMinutes = Number.parseInt(match[1]?.match(/^\d+$/) ? match[1] : match[2] ?? "", 10);
    const rawReminderText = match[1]?.match(/^\d+$/) ? match[2] : match[1];
    const reminderText = normalizeReminderText(rawReminderText ?? "");
    if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0 || !reminderText) {
      return null;
    }

    return {
      actionName: "reminder_create",
      scheduleMode: "once",
      reminderText,
      runAtIso: new Date(now.getTime() + (intervalMinutes * 60_000)).toISOString(),
      timingText: intervalMinutes === 1 ? "in 1 minute" : `in ${intervalMinutes} minutes`,
    };
  }

  const datePatterns = [
    {
      pattern: /^remind\s+me\s+on\s+(.+?)\s+at\s+(.+?)\s+to\s+(.+)$/i,
      dateIndex: 1,
      timeIndex: 2,
      textIndex: 3,
    },
    {
      pattern: /^remind\s+me\s+to\s+(.+?)\s+on\s+(.+?)\s+at\s+(.+)$/i,
      dateIndex: 2,
      timeIndex: 3,
      textIndex: 1,
    },
  ] as const;

  for (const entry of datePatterns) {
    const match = normalized.match(entry.pattern);
    const rawDate = match?.[entry.dateIndex];
    const rawTime = match?.[entry.timeIndex];
    const rawText = match?.[entry.textIndex];
    if (!rawDate || !rawTime || !rawText) {
      continue;
    }

    const calendarDate = parseCalendarDate(rawDate);
    const clockTime = parseClockTime(rawTime);
    const reminderText = normalizeReminderText(rawText);
    if (!calendarDate || !clockTime || !reminderText) {
      return null;
    }

    const runAtIso = resolveRunAtForCalendarDate(
      calendarDate,
      clockTime,
      now,
    );
    if (!runAtIso) {
      return null;
    }

    return {
      actionName: "reminder_create",
      scheduleMode: "once",
      reminderText,
      runAtIso,
      timingText: `on ${calendarDate.label} at ${clockTime.label}`,
    };
  }

  const clockPatterns = [
    {
      pattern: /^remind\s+me\s+tomorrow\s+at\s+(.+?)\s+to\s+(.+)$/i,
      dayOffset: 1,
      timingPrefix: "tomorrow at",
      timeIndex: 1,
      textIndex: 2,
    },
    {
      pattern: /^remind\s+me\s+to\s+(.+?)\s+tomorrow\s+at\s+(.+)$/i,
      dayOffset: 1,
      timingPrefix: "tomorrow at",
      timeIndex: 2,
      textIndex: 1,
    },
    {
      pattern: /^remind\s+me\s+at\s+(.+?)\s+to\s+(.+)$/i,
      dayOffset: 0,
      timingPrefix: "at",
      timeIndex: 1,
      textIndex: 2,
    },
    {
      pattern: /^remind\s+me\s+to\s+(.+?)\s+at\s+(.+)$/i,
      dayOffset: 0,
      timingPrefix: "at",
      timeIndex: 2,
      textIndex: 1,
    },
  ] as const;

  for (const entry of clockPatterns) {
    const match = normalized.match(entry.pattern);
    const rawTime = match?.[entry.timeIndex];
    const rawText = match?.[entry.textIndex];
    if (!rawTime || !rawText) {
      continue;
    }

    const clockTime = parseClockTime(rawTime);
    const reminderText = normalizeReminderText(rawText);
    if (!clockTime || !reminderText) {
      return null;
    }

    return {
      actionName: "reminder_create",
      scheduleMode: "once",
      reminderText,
      runAtIso: resolveRunAtForClockTime(clockTime, now, entry.dayOffset),
      timingText: `${entry.timingPrefix} ${clockTime.label}`,
    };
  }

  return null;
}

export function validateReminderIntervalMinutes(
  intervalMinutes: number,
): string | null {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) {
    return "Reminder intervals must be positive whole minutes.";
  }

  if (intervalMinutes > 59) {
    return "Reminder intervals must be between 1 and 59 minutes right now.";
  }

  return null;
}

export function buildReminderCronExpression(intervalMinutes: number): string {
  return intervalMinutes === 1 ? "* * * * *" : `*/${intervalMinutes} * * * *`;
}

export function formatReminderInterval(intervalMinutes: number): string {
  return intervalMinutes === 1
    ? "every 1 minute"
    : `every ${intervalMinutes} minutes`;
}

export function formatOneTimeReminderDelay(intervalMinutes: number): string {
  return intervalMinutes === 1
    ? "in 1 minute"
    : `in ${intervalMinutes} minutes`;
}

export function buildReminderDeliveryText(reminderText: string): string {
  const normalized = normalizeReminderText(reminderText);
  if (/^reminder\s*:/i.test(normalized)) {
    return normalized;
  }

  return `Reminder: ${normalized}`;
}

export function encodeStaticReminderPrompt(reminderText: string): string {
  return `${STATIC_REMINDER_PREFIX}${buildReminderDeliveryText(reminderText)}`;
}

export function decodeStaticReminderPrompt(prompt: string): string | null {
  if (!prompt.startsWith(STATIC_REMINDER_PREFIX)) {
    return null;
  }

  const reminderText = prompt.slice(STATIC_REMINDER_PREFIX.length).trim();
  return reminderText || null;
}

export function buildReminderTaskName(
  chatId: string,
  reminderText: string,
  scheduleMode: "recurring" | "once" = "recurring",
): string {
  return [
    scheduleMode === "once" ? "reminder-once" : "reminder",
    chatId,
    buildReminderSlug(reminderText),
    buildReminderChecksum(reminderText),
  ].join("-");
}
