import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveShellCommandPolicy, tokenizeShellCommand, type ShellPolicyConfig } from "./shell-policy.js";

export type ShellExecutionOutput = {
  success: boolean;
  output: string | null;
  error: string | null;
  resultSize: number;
};

type SpawnLike = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    windowsHide: boolean;
    stdio: "pipe";
  },
) => ChildProcessWithoutNullStreams;

function appendChunk(
  state: {
    output: string;
    outputBytes: number;
    truncated: boolean;
  },
  chunk: Buffer,
  maxOutputBytes: number,
): void {
  if (state.truncated || maxOutputBytes <= 0) {
    state.truncated = true;
    return;
  }

  const remainingBytes = maxOutputBytes - state.outputBytes;
  if (remainingBytes <= 0) {
    state.truncated = true;
    return;
  }

  const limitedChunk = chunk.byteLength > remainingBytes
    ? chunk.subarray(0, remainingBytes)
    : chunk;
  state.output += limitedChunk.toString("utf8");
  state.outputBytes += limitedChunk.byteLength;
  if (limitedChunk.byteLength < chunk.byteLength) {
    state.truncated = true;
  }
}

function formatOutput(state: {
  output: string;
  truncated: boolean;
}): string | null {
  const normalized = state.output.trim();
  if (!normalized) {
    return state.truncated ? "[output truncated]" : null;
  }

  if (!state.truncated) {
    return normalized;
  }

  return `${normalized}\n[output truncated]`;
}

export async function executeShellCommand(
  commandText: string,
  config: ShellPolicyConfig & { timeoutMs: number },
  spawnImpl: SpawnLike = spawn as SpawnLike,
): Promise<ShellExecutionOutput> {
  const decision = resolveShellCommandPolicy(commandText, config);
  if (!decision.allowed) {
    const error = decision.error;
    return {
      success: false,
      output: null,
      error,
      resultSize: Buffer.byteLength(error, "utf8"),
    };
  }

  const tokens = tokenizeShellCommand(decision.normalizedCommand);
  const executable = tokens[0];
  const args = tokens.slice(1);
  if (!executable) {
    const error = "Shell command is missing an executable";
    return {
      success: false,
      output: null,
      error,
      resultSize: Buffer.byteLength(error, "utf8"),
    };
  }

  const outputState = {
    output: "",
    outputBytes: 0,
    truncated: false,
  };

  return new Promise<ShellExecutionOutput>((resolve) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const finish = (result: ShellExecutionOutput) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolve(result);
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnImpl(executable, args, {
        cwd: config.workingDirectory,
        windowsHide: true,
        stdio: "pipe",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish({
        success: false,
        output: null,
        error: `Shell command failed to start: ${message}`,
        resultSize: Buffer.byteLength(message, "utf8"),
      });
      return;
    }

    timeoutHandle = setTimeout(() => {
      child.kill("SIGKILL");
      const error = `Shell command timed out after ${config.timeoutMs}ms`;
      finish({
        success: false,
        output: formatOutput(outputState),
        error,
        resultSize: Buffer.byteLength(
          formatOutput(outputState) ?? error,
          "utf8",
        ),
      });
    }, config.timeoutMs);

    const handleChunk = (chunk: Buffer) => {
      appendChunk(outputState, chunk, config.maxOutputBytes);
      if (outputState.truncated) {
        child.kill("SIGKILL");
      }
    };

    child.stdout.on("data", handleChunk);
    child.stderr.on("data", handleChunk);

    child.once("error", (error) => {
      const message = error.message || "Shell command failed unexpectedly";
      finish({
        success: false,
        output: formatOutput(outputState),
        error: `Shell command failed: ${message}`,
        resultSize: Buffer.byteLength(
          formatOutput(outputState) ?? message,
          "utf8",
        ),
      });
    });

    child.once("close", (code, signal) => {
      const output = formatOutput(outputState);
      if (outputState.truncated) {
        const error = `Shell output exceeded ${config.maxOutputBytes} bytes`;
        finish({
          success: false,
          output,
          error,
          resultSize: Buffer.byteLength(output ?? error, "utf8"),
        });
        return;
      }

      if (signal) {
        const error = `Shell command terminated by signal ${signal}`;
        finish({
          success: false,
          output,
          error,
          resultSize: Buffer.byteLength(output ?? error, "utf8"),
        });
        return;
      }

      if (code !== 0) {
        const error = `Shell command exited with code ${code ?? "unknown"}`;
        finish({
          success: false,
          output,
          error,
          resultSize: Buffer.byteLength(output ?? error, "utf8"),
        });
        return;
      }

      finish({
        success: true,
        output: output ?? "(no output)",
        error: null,
        resultSize: Buffer.byteLength(output ?? "(no output)", "utf8"),
      });
    });
  });
}
