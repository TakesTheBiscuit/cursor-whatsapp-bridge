import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = resolve(srcDir, "..");

loadEnv({ path: resolve(ROOT_DIR, ".env") });

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const workspaceRaw = optional("WORKSPACE_PATH") ?? ROOT_DIR;
export const WORKSPACE_PATH = isAbsolute(workspaceRaw)
  ? workspaceRaw
  : resolve(ROOT_DIR, workspaceRaw);

export const CURSOR_API_KEY = optional("CURSOR_API_KEY");
export const CURSOR_MODEL = optional("CURSOR_MODEL");
export const CURSOR_BIN = optional("CURSOR_BIN");

export const AUTH_DIR = resolve(ROOT_DIR, "auth");
export const DATA_DIR = resolve(ROOT_DIR, "data");
export const LOCK_PATH = resolve(ROOT_DIR, ".agent.lock");
export const STATE_PATH = resolve(DATA_DIR, "state.json");
export const THREAD_PATH = resolve(DATA_DIR, "thread.jsonl");

export const WHATSAPP_CHUNK = 3500;

export function assertWorkspace(): void {
  if (!existsSync(WORKSPACE_PATH)) {
    throw new Error(`WORKSPACE_PATH does not exist: ${WORKSPACE_PATH}`);
  }
}
