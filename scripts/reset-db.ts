import { rm } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.js";

function isFilesystemRoot(resolvedPath: string): boolean {
  return path.parse(resolvedPath).root === resolvedPath;
}

async function main() {
  const config = await loadConfig();
  if (config.database.path === ":memory:") {
    console.log("[reset-db] database is in-memory; nothing to delete");
    return;
  }

  const cwd = process.cwd();
  const resolvedDatabasePath = path.resolve(cwd, config.database.path);
  if (isFilesystemRoot(resolvedDatabasePath)) {
    throw new Error("Refusing to delete a filesystem root");
  }

  const relativePath = path.relative(cwd, resolvedDatabasePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(
      `Refusing to delete database outside the workspace: ${resolvedDatabasePath}`,
    );
  }

  for (const targetPath of [
    resolvedDatabasePath,
    `${resolvedDatabasePath}-shm`,
    `${resolvedDatabasePath}-wal`,
  ]) {
    await rm(targetPath, { force: true });
  }

  console.log(`[reset-db] removed ${resolvedDatabasePath} and SQLite sidecar files`);
}

void main().catch((error) => {
  console.error("[reset-db] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
