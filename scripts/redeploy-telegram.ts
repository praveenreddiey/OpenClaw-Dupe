import { spawn } from "node:child_process";

type CommandResult = {
  stdout: string;
  stderr: string;
};

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    captureOutput?: boolean;
  },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.captureOutput ? "pipe" : "inherit",
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    if (options.captureOutput) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const reason = options.captureOutput
        ? (stderr.trim() || stdout.trim() || `exit code ${code}`)
        : `exit code ${code}`;
      reject(new Error(`${command} ${args.join(" ")} failed: ${reason}`));
    });
  });
}

async function main(): Promise<void> {
  const cwd = process.cwd();

  console.log("[redeploy] stopping Docker services");
  await runCommand(
    "docker",
    ["compose", "--env-file", ".env", "down"],
    { cwd },
  );

  console.log("[redeploy] rebuilding and starting Docker services");
  await runCommand(
    "docker",
    ["compose", "--env-file", ".env", "up", "--build", "-d"],
    { cwd },
  );
}

void main().catch((error) => {
  console.error("[redeploy] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
