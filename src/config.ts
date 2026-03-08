import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

export type AppConfig = {
  server: { host: string; port: number };
  logger: { level: string };
};

const defaults: AppConfig = {
  server: { host: "0.0.0.0", port: 3000 },
  logger: { level: "info" },
};

export async function loadConfig(
  configPath = process.env.CONFIG_PATH ?? "config.yaml",
): Promise<AppConfig> {
  const resolved = path.resolve(process.cwd(), configPath);
  try {
    const file = await fs.readFile(resolved, "utf8");
    const parsed = parse(file) as Partial<AppConfig>;
    return {
      server: {
        host: parsed?.server?.host ?? defaults.server.host,
        port: Number(parsed?.server?.port ?? defaults.server.port),
      },
      logger: {
        level: parsed?.logger?.level ?? defaults.logger.level,
      },
    };
  } catch (err) {
    console.warn(
      `[config] Using defaults because ${resolved} could not be read:`,
      (err as Error).message,
    );
    return defaults;
  }
}

// To understand this, let’s look at your OpenClaw project and compare it to a Spring Boot server.

// Imagine your agent is running, and you have two users trying to use your bot at the exact same time.

// The Scenario
// User A sends a message: "Check my logs/ folder for errors." (This triggers your loadConfig + file reading logic).

// User B sends a message: "Are you alive?" (This just hits a simple reply("Yes!") function).
// In Spring Boot (Multithreaded)
// Request A arrives. The server assigns it Thread 1.

// Thread 1 hits readFile(). It blocks. Thread 1 sits there, doing absolutely nothing, waiting for the hard drive.

// Request B arrives. The server assigns it Thread 2.

// Thread 2 executes your code and replies to User B immediately.

// Thread 1 finally gets the file, resumes, and replies to User A.

// The Reality: The server is "parallel" because you have multiple threads (workers) waiting in line. If you get 500 users at once, you need 500 threads.

// In Node.js (Event Loop)
// Request A arrives. The server puts it into the Event Loop.

// Your loadConfig function runs. It hits await fs.readFile().

// The "Pause": Node.js offloads the file-reading job to the Operating System. It says, "OS, let me know when this file is ready."

// Crucially: Node.js clears the call stack. It forgets about User A for a microsecond.

// Request B arrives immediately. Node.js sees the Event Loop is "empty" (it's not waiting on any code execution), so it picks up Request B.

// The reply("Yes!") code for Request B runs to completion.

// Callback: The OS signals that the file for User A is ready. Node.js takes the result, puts it back into the Event Loop, and resumes your loadConfig function exactly where it left off.
