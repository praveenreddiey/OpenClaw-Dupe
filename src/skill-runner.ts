import path from "node:path";
import { Worker } from "node:worker_threads";
import { resolveShellWorkingDirectory, type ShellAllowlistEntry } from "./shell-policy.js";
import type { SkillExecutionRequest, SkillExecutionResult } from "./skills.js";

export type SkillRunnerConfig = {
  enabled: boolean;
  timeoutMs: number;
  maxOldGenerationSizeMb: number;
  maxReadBytes: number;
  maxWriteBytes: number;
  allowedPaths: string[];
  blockedPaths: string[];
  shellEnabled: boolean;
  shellWorkingDirectory: string;
  shellMaxOutputBytes: number;
  shellAllowlist: ShellAllowlistEntry[];
};

type NormalizedSkillRunnerConfig = Omit<
  SkillRunnerConfig,
  "allowedPaths" | "blockedPaths" | "shellWorkingDirectory"
> & {
  cwd: string;
  allowedPaths: string[];
  blockedPaths: string[];
  shellWorkingDirectory: string;
};

type WorkerPayload = {
  request: SkillExecutionRequest;
  config: NormalizedSkillRunnerConfig;
};

type WorkerResult = Omit<SkillExecutionResult, "meta"> & {
  meta: Omit<SkillExecutionResult["meta"], "durationMs">;
};

type WorkerLike = {
  once(event: "message", listener: (value: WorkerResult) => void): WorkerLike;
  once(event: "error", listener: (error: Error) => void): WorkerLike;
  once(event: "exit", listener: (code: number) => void): WorkerLike;
  terminate(): Promise<number>;
};

export type SkillRunner = {
  execute(request: SkillExecutionRequest): Promise<SkillExecutionResult>;
};

type SkillRunnerOptions = {
  cwd?: string;
  createWorker?: (payload: WorkerPayload) => WorkerLike;
};

function isFilesystemRoot(resolvedPath: string): boolean {
  return path.parse(resolvedPath).root === resolvedPath;
}

function normalizeScopePath(scopePath: string, cwd: string): string {
  const resolved = path.resolve(cwd, scopePath);
  if (isFilesystemRoot(resolved)) {
    throw new Error(`skill path '${scopePath}' cannot be a filesystem root`);
  }

  return resolved;
}

function normalizeConfig(
  config: SkillRunnerConfig,
  cwd: string,
): NormalizedSkillRunnerConfig {
  return {
    ...config,
    cwd,
    allowedPaths: config.allowedPaths.map((entry) => normalizeScopePath(entry, cwd)),
    blockedPaths: config.blockedPaths.map((entry) => normalizeScopePath(entry, cwd)),
    shellWorkingDirectory: resolveShellWorkingDirectory(cwd, config.shellWorkingDirectory),
  };
}

function createWorkerInstance(payload: WorkerPayload): WorkerLike {
  return new Worker(new URL("./skill-worker.js", import.meta.url), {
    workerData: payload,
    resourceLimits: {
      maxOldGenerationSizeMb: payload.config.maxOldGenerationSizeMb,
    },
  });
}

function getRequestTarget(request: SkillExecutionRequest): string {
  if ("path" in request) {
    return request.path;
  }

  return request.command;
}

function buildFailureResult(
  request: SkillExecutionRequest,
  durationMs: number,
  error: string,
): SkillExecutionResult {
  return {
    success: false,
    output: null,
    error,
    meta: {
      skillName: request.skillName,
      targetPath: getRequestTarget(request),
      durationMs,
      resultSize: Buffer.byteLength(error, "utf8"),
    },
  };
}

export function createSkillRunner(
  config: SkillRunnerConfig,
  options: SkillRunnerOptions = {},
): SkillRunner {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const normalizedConfig = normalizeConfig(config, cwd);
  const createWorker = options.createWorker ?? createWorkerInstance;

  return {
    async execute(request) {
      const startedAt = Date.now();

      return new Promise<SkillExecutionResult>((resolve) => {
        const worker = createWorker({
          request,
          config: normalizedConfig,
        });

        let settled = false;
        let terminatingForTimeout = false;

        const finish = (result: SkillExecutionResult) => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timeoutHandle);
          resolve(result);
        };

        const timeoutHandle = setTimeout(() => {
          terminatingForTimeout = true;
          void worker.terminate()
            .catch(() => 1)
            .finally(() => {
              finish(
                buildFailureResult(
                  request,
                  Date.now() - startedAt,
                  `Skill execution timed out after ${normalizedConfig.timeoutMs}ms`,
                ),
              );
            });
        }, normalizedConfig.timeoutMs);

        worker.once("message", (result) => {
          finish({
            ...result,
            meta: {
              ...result.meta,
              durationMs: Date.now() - startedAt,
            },
          });
        });

        worker.once("error", (error) => {
          finish(
            buildFailureResult(
              request,
              Date.now() - startedAt,
              error.message || "Skill worker failed unexpectedly",
            ),
          );
        });

        worker.once("exit", (code) => {
          if (settled || terminatingForTimeout || code === 0) {
            return;
          }

          finish(
            buildFailureResult(
              request,
              Date.now() - startedAt,
              `Skill worker exited unexpectedly with code ${code}`,
            ),
          );
        });
      });
    },
  };
}
