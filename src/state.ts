import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DATA_DIR, STATE_PATH, THREAD_PATH } from "./config.ts";

export type BridgeStatus = "idle" | "busy";

export type BridgeState = {
  sessionId: string | null;
  lastProcessedTs: number;
  status: BridgeStatus;
};

const EMPTY: BridgeState = {
  sessionId: null,
  lastProcessedTs: 0,
  status: "idle",
};

let cache: BridgeState | null = null;

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

export async function loadState(): Promise<BridgeState> {
  if (cache) return cache;
  await ensureDataDir();
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<BridgeState>;
    cache = {
      sessionId: parsed.sessionId ?? null,
      lastProcessedTs: Number(parsed.lastProcessedTs) || 0,
      status: parsed.status === "busy" ? "idle" : (parsed.status ?? "idle"),
    };
  } catch {
    cache = { ...EMPTY };
  }
  return cache;
}

export async function saveState(patch: Partial<BridgeState>): Promise<BridgeState> {
  const current = await loadState();
  cache = { ...current, ...patch };
  await ensureDataDir();
  await writeFile(STATE_PATH, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  return cache;
}

export async function appendThread(
  role: "user" | "assistant" | "system",
  text: string,
): Promise<void> {
  await ensureDataDir();
  await mkdir(dirname(THREAD_PATH), { recursive: true });
  const line = JSON.stringify({ ts: Date.now(), role, text }) + "\n";
  await appendFile(THREAD_PATH, line, "utf8");
}
