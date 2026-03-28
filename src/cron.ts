type CronFieldName =
  | "minute"
  | "hour"
  | "dayOfMonth"
  | "month"
  | "dayOfWeek";

type CronField = {
  values: Set<number>;
  isWildcard: boolean;
};

export type ParsedCronExpression = {
  expression: string;
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

const FIELD_RANGES: Record<CronFieldName, { min: number; max: number }> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 7 },
};

function addRangeValues(
  target: Set<number>,
  start: number,
  end: number,
  step: number,
  fieldName: CronFieldName,
): void {
  const { min, max } = FIELD_RANGES[fieldName];

  if (start < min || end > max || start > end) {
    throw new Error(`Invalid ${fieldName} range '${start}-${end}'`);
  }

  if (!Number.isInteger(step) || step <= 0) {
    throw new Error(`Invalid ${fieldName} step '${step}'`);
  }

  for (let value = start; value <= end; value += step) {
    if (fieldName === "dayOfWeek" && value === 7) {
      target.add(0);
    } else {
      target.add(value);
    }
  }
}

function parseFieldSegment(
  segment: string,
  fieldName: CronFieldName,
  target: Set<number>,
): void {
  const normalized = segment.trim();
  if (!normalized) {
    throw new Error(`Empty ${fieldName} segment`);
  }

  const match = normalized.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
  if (!match) {
    throw new Error(`Unsupported ${fieldName} segment '${segment}'`);
  }

  const [, base, rawStep] = match;
  const step = rawStep ? Number.parseInt(rawStep, 10) : 1;
  const { min, max } = FIELD_RANGES[fieldName];

  if (base === "*") {
    addRangeValues(target, min, max, step, fieldName);
    return;
  }

  const [rawStart, rawEnd] = base.split("-");
  const start = Number.parseInt(rawStart ?? "", 10);
  const end = rawEnd ? Number.parseInt(rawEnd, 10) : start;
  addRangeValues(target, start, end, step, fieldName);
}

function parseCronField(
  rawField: string,
  fieldName: CronFieldName,
): CronField {
  const normalized = rawField.trim();
  if (!normalized) {
    throw new Error(`Missing ${fieldName} field`);
  }

  const isWildcard = normalized === "*";
  const values = new Set<number>();

  for (const segment of normalized.split(",")) {
    parseFieldSegment(segment, fieldName, values);
  }

  if (values.size === 0) {
    throw new Error(`Cron ${fieldName} field '${rawField}' has no values`);
  }

  return {
    values,
    isWildcard,
  };
}

function matchesDayFields(
  date: Date,
  parsed: ParsedCronExpression,
): boolean {
  const dayOfMonthMatch = parsed.dayOfMonth.values.has(date.getDate());
  const dayOfWeekMatch = parsed.dayOfWeek.values.has(date.getDay());

  if (parsed.dayOfMonth.isWildcard && parsed.dayOfWeek.isWildcard) {
    return true;
  }

  if (parsed.dayOfMonth.isWildcard) {
    return dayOfWeekMatch;
  }

  if (parsed.dayOfWeek.isWildcard) {
    return dayOfMonthMatch;
  }

  return dayOfMonthMatch || dayOfWeekMatch;
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const normalized = expression.trim().replace(/\s+/g, " ");
  const parts = normalized.split(" ");

  if (parts.length !== 5) {
    throw new Error(
      `Cron expression '${expression}' must have 5 fields (minute hour day-of-month month day-of-week)`,
    );
  }

  return {
    expression: normalized,
    minute: parseCronField(parts[0] ?? "", "minute"),
    hour: parseCronField(parts[1] ?? "", "hour"),
    dayOfMonth: parseCronField(parts[2] ?? "", "dayOfMonth"),
    month: parseCronField(parts[3] ?? "", "month"),
    dayOfWeek: parseCronField(parts[4] ?? "", "dayOfWeek"),
  };
}

export function validateCronExpression(expression: string): void {
  parseCronExpression(expression);
}

export function getNextCronOccurrence(
  expression: string,
  afterDate: Date,
  maxIterations = 366 * 24 * 60,
): Date {
  const parsed = parseCronExpression(expression);
  const candidate = new Date(afterDate);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (
      parsed.minute.values.has(candidate.getMinutes()) &&
      parsed.hour.values.has(candidate.getHours()) &&
      parsed.month.values.has(candidate.getMonth() + 1) &&
      matchesDayFields(candidate, parsed)
    ) {
      return new Date(candidate);
    }

    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(
    `Could not find next cron occurrence for '${expression}' within ${maxIterations} minutes`,
  );
}
