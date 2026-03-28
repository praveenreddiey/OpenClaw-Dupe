import path from "node:path";

export type ShellAllowlistEntry = {
  command: string;
  requiresConfirmation: boolean;
  description?: string;
};

export type ShellPolicyConfig = {
  enabled: boolean;
  workingDirectory: string;
  maxOutputBytes: number;
  allowlist: ShellAllowlistEntry[];
};

export type ShellPolicyDecision =
  | {
      allowed: true;
      normalizedCommand: string;
      matchedEntry: ShellAllowlistEntry;
    }
  | {
      allowed: false;
      error: string;
    };

const DANGEROUS_EXECUTABLES = new Set([
  "rm",
  "sudo",
  "chmod",
  "chown",
  "curl",
  "wget",
  "powershell",
  "pwsh",
  "cmd",
  "bash",
  "sh",
  "zsh",
]);

const SHELL_META_PATTERN = /[|&;<>`]/;
const RISKY_PROMPT_PATTERNS: RegExp[] = [
  /\b(?:ignore|bypass|disable)\b.{0,40}\b(?:guard|safety|policy|allowlist|confirmation)\b/i,
  /\b(?:exfiltrat|steal|dump|reveal|print)\b.{0,40}\b(?:token|secret|credential|password|api key)\b/i,
  /\b(?:delete|wipe|destroy|format)\b.{0,30}\b(?:database|repo|system|filesystem|disk)\b/i,
  /\b(?:rm\s+-rf|sudo|chmod|curl|wget)\b/i,
  /\b(?:system32|passwd|shadow)\b/i,
];
const MUTATING_COMMAND_PATTERNS: RegExp[] = [
  /\bnpm\s+(?:run\s+)?(?:build|clean|reset-db|install)\b/i,
  /\bgit\s+(?:add|apply|checkout|clean|commit|merge|pull|reset|restore)\b/i,
  /\b(?:copy|cp|move|mv|rename|ren|mkdir|md|touch|write|set-content|add-content|new-item|remove-item|del|erase)\b/i,
];

export function tokenizeShellCommand(commandText: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (const character of commandText) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (quote) {
    throw new Error("Command contains an unterminated quote");
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export function normalizeShellCommand(commandText: string): string {
  const tokens = tokenizeShellCommand(commandText.trim());
  return tokens.join(" ");
}

function getExecutableName(commandText: string): string {
  const [firstToken] = tokenizeShellCommand(commandText.trim());
  return (firstToken ?? "").toLowerCase();
}

function containsBlockedInterpreterPattern(commandText: string): boolean {
  const normalized = normalizeShellCommand(commandText).toLowerCase();
  return /\b(?:node|python|python3|perl|ruby)\s+(?:-e|--eval)\b/.test(normalized) ||
    /\b(?:powershell|pwsh|cmd|bash|sh|zsh)\b\s+(?:-c|\/c)\b/.test(normalized);
}

export function isMutatingShellCommand(commandText: string): boolean {
  return MUTATING_COMMAND_PATTERNS.some((pattern) => pattern.test(commandText));
}

export function validateShellAllowlistEntry(entry: ShellAllowlistEntry): void {
  const normalized = normalizeShellCommand(entry.command);
  if (!normalized) {
    throw new Error("Shell allowlist entries must include a command");
  }

  const executable = getExecutableName(normalized);
  if (!executable) {
    throw new Error(`Shell allowlist entry '${entry.command}' is missing an executable`);
  }

  if (DANGEROUS_EXECUTABLES.has(executable)) {
    throw new Error(
      `Shell allowlist entry '${entry.command}' uses blocked executable '${executable}'`,
    );
  }

  if (SHELL_META_PATTERN.test(entry.command)) {
    throw new Error(
      `Shell allowlist entry '${entry.command}' contains blocked shell control characters`,
    );
  }

  if (containsBlockedInterpreterPattern(entry.command)) {
    throw new Error(
      `Shell allowlist entry '${entry.command}' uses a blocked interpreter-eval pattern`,
    );
  }

  if (isMutatingShellCommand(entry.command) && !entry.requiresConfirmation) {
    throw new Error(
      `Shell allowlist entry '${entry.command}' must require confirmation because it may modify files`,
    );
  }
}

export function detectRiskyShellPrompt(userText: string): string | null {
  for (const pattern of RISKY_PROMPT_PATTERNS) {
    if (pattern.test(userText)) {
      return `Risky shell prompt detected by policy pattern '${pattern.source}'`;
    }
  }

  return null;
}

function validateRequestedCommand(commandText: string): string | null {
  if (!commandText.trim()) {
    return "Shell command is required";
  }

  if (SHELL_META_PATTERN.test(commandText)) {
    return "Shell command contains blocked control characters";
  }

  const executable = getExecutableName(commandText);
  if (!executable) {
    return "Shell command is missing an executable";
  }

  if (DANGEROUS_EXECUTABLES.has(executable)) {
    return `Shell command '${executable}' is blocked for safety`;
  }

  if (containsBlockedInterpreterPattern(commandText)) {
    return "Shell command uses a blocked interpreter-eval pattern";
  }

  return null;
}

export function resolveShellCommandPolicy(
  commandText: string,
  config: Pick<ShellPolicyConfig, "enabled" | "allowlist">,
): ShellPolicyDecision {
  if (!config.enabled) {
    return {
      allowed: false,
      error: "Shell commands are disabled in this build.",
    };
  }

  const validationError = validateRequestedCommand(commandText);
  if (validationError) {
    return {
      allowed: false,
      error: validationError,
    };
  }

  const normalizedCommand = normalizeShellCommand(commandText);
  const matchedEntry = config.allowlist.find((entry) =>
    normalizeShellCommand(entry.command) === normalizedCommand
  );
  if (!matchedEntry) {
    return {
      allowed: false,
      error: `Shell command '${normalizedCommand}' is not in the command allowlist`,
    };
  }

  return {
    allowed: true,
    normalizedCommand,
    matchedEntry,
  };
}

export function resolveShellWorkingDirectory(
  cwd: string,
  workingDirectory: string,
): string {
  const resolved = path.resolve(cwd, workingDirectory);
  if (path.parse(resolved).root === resolved) {
    throw new Error("skills.shellWorkingDirectory must not be a filesystem root");
  }

  return resolved;
}
