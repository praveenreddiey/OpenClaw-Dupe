import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { executeShellCommand } from "./shell-executor.js";
import type { SkillExecutionRequest, SkillExecutionResult, SkillName } from "./skills.js";
import type { SkillRunnerConfig } from "./skill-runner.js";

type NormalizedSkillRunnerConfig = Omit<
  SkillRunnerConfig,
  "allowedPaths" | "blockedPaths"
> & {
  cwd: string;
  allowedPaths: string[];
  blockedPaths: string[];
};

type WorkerPayload = {
  request: SkillExecutionRequest;
  config: NormalizedSkillRunnerConfig;
};

type WorkerResult = Omit<SkillExecutionResult, "meta"> & {
  meta: Omit<SkillExecutionResult["meta"], "durationMs">;
};

function normalizeForComparison(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInsideScope(candidatePath: string, scopePath: string): boolean {
  const normalizedCandidate = normalizeForComparison(candidatePath);
  const normalizedScope = normalizeForComparison(scopePath);
  return normalizedCandidate === normalizedScope ||
    normalizedCandidate.startsWith(`${normalizedScope}${path.sep}`);
}

function displayPath(cwd: string, resolvedPath: string): string {
  const relativePath = path.relative(cwd, resolvedPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return resolvedPath;
  }

  return relativePath.replace(/\\/g, "/");
}

function resolveTargetPath(
  requestedPath: string,
  config: NormalizedSkillRunnerConfig,
): { resolvedPath: string; targetPath: string } {
  const resolvedPath = path.resolve(config.cwd, requestedPath);
  const insideAllowedPath = config.allowedPaths.some((scopePath) =>
    isPathInsideScope(resolvedPath, scopePath)
  );
  if (!insideAllowedPath) {
    throw new Error(`Path '${requestedPath}' is outside the skill allowlist`);
  }

  const insideBlockedPath = config.blockedPaths.some((scopePath) =>
    isPathInsideScope(resolvedPath, scopePath)
  );
  if (insideBlockedPath) {
    throw new Error(`Path '${requestedPath}' is blocked for safety`);
  }

  return {
    resolvedPath,
    targetPath: displayPath(config.cwd, resolvedPath),
  };
}

function buildResult(
  request: SkillExecutionRequest,
  targetPath: string,
  success: boolean,
  output: string | null,
  error: string | null,
  resultSize?: number,
): WorkerResult {
  const measuredText = output ?? error ?? "";
  return {
    success,
    output,
    error,
    meta: {
      skillName: request.skillName,
      targetPath,
      resultSize: resultSize ?? Buffer.byteLength(measuredText, "utf8"),
    },
  };
}

async function runFsRead(
  request: Extract<SkillExecutionRequest, { skillName: "fs_read" }>,
  config: NormalizedSkillRunnerConfig,
): Promise<WorkerResult> {
  const { resolvedPath, targetPath } = resolveTargetPath(request.path, config);
  const fileStats = await stat(resolvedPath);
  if (!fileStats.isFile()) {
    throw new Error(`Path '${request.path}' is not a regular file`);
  }

  if (fileStats.size > config.maxReadBytes) {
    throw new Error(
      `Read limit exceeded for '${request.path}': ${fileStats.size} bytes is above ${config.maxReadBytes} bytes`,
    );
  }

  const content = await readFile(resolvedPath, "utf8");
  return buildResult(request, targetPath, true, content, null);
}

async function runFsWrite(
  request: Extract<SkillExecutionRequest, { skillName: "fs_write" }>,
  config: NormalizedSkillRunnerConfig,
): Promise<WorkerResult> {
  const { resolvedPath, targetPath } = resolveTargetPath(request.path, config);
  const contentBytes = Buffer.byteLength(request.content, "utf8");
  if (contentBytes > config.maxWriteBytes) {
    throw new Error(
      `Write limit exceeded for '${request.path}': ${contentBytes} bytes is above ${config.maxWriteBytes} bytes`,
    );
  }

  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, request.content, "utf8");

  return buildResult(
    request,
    targetPath,
    true,
    `Wrote ${contentBytes} bytes to ${targetPath}.`,
    null,
  );
}

async function runShellExec(
  request: Extract<SkillExecutionRequest, { skillName: "shell_exec" }>,
  config: NormalizedSkillRunnerConfig,
): Promise<WorkerResult> {
  const result = await executeShellCommand(request.command, {
    enabled: config.shellEnabled,
    allowlist: config.shellAllowlist,
    workingDirectory: config.shellWorkingDirectory,
    maxOutputBytes: config.shellMaxOutputBytes,
    timeoutMs: config.timeoutMs,
  });

  return buildResult(
    request,
    request.command,
    result.success,
    result.output,
    result.error,
    result.resultSize,
  );
}

async function executeSkill(
  request: SkillExecutionRequest,
  config: NormalizedSkillRunnerConfig,
): Promise<WorkerResult> {
  if (request.skillName === "fs_read") {
    return runFsRead(request, config);
  }

  if (request.skillName === "fs_write") {
    return runFsWrite(request, config);
  }

  if (request.skillName === "shell_exec") {
    return runShellExec(request, config);
  }

  const neverRequest: never = request;
  throw new Error(`Unsupported skill '${(neverRequest as { skillName?: SkillName }).skillName ?? "unknown"}'`);
}

async function main() {
  const payload = workerData as WorkerPayload;

  try {
    const result = await executeSkill(payload.request, payload.config);
    parentPort?.postMessage(result);
  } catch (error) {
    const targetPath = "path" in payload.request
      ? payload.request.path
      : payload.request.command;
    const message = error instanceof Error ? error.message : String(error);
    parentPort?.postMessage(
      buildResult(payload.request, targetPath, false, null, message),
    );
  }
}

void main();
