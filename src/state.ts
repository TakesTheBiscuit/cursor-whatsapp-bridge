import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DATA_DIR, STATE_PATH, THREAD_PATH } from "./config.ts";

export type BridgeStatus = "idle" | "busy";

export type BridgeState = {
  sessionId: string | null;
  lastProcessedTs: number;
  status: BridgeStatus;
  processedIds: string[];
  selfJids: string[];
};

const EMPTY: BridgeState = {
  sessionId: null,
  lastProcessedTs: 0,
  status: "idle",
  processedIds: [],
  selfJids: [],
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
      processedIds: Array.isArray(parsed.processedIds) ? parsed.processedIds.filter((id) => typeof id === "string") : [],
      selfJids: Array.isArray(parsed.selfJids) ? parsed.selfJids.filter((id) => typeof id === "string") : [],
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

const PROCESSED_CAP = 400;
const SELF_JID_CAP = 20;

export async function rememberProcessedId(id: string): Promise<void> {
  const state = await loadState();
  if (state.processedIds.includes(id)) return;
  const processedIds = [...state.processedIds, id];
  if (processedIds.length > PROCESSED_CAP) processedIds.splice(0, processedIds.length - PROCESSED_CAP);
  await saveState({ processedIds });
}

export async function rememberSelfJid(jid: string): Promise<void> {
  const normalized = jid.trim();
  if (!normalized) return;
  const state = await loadState();
  if (state.selfJids.includes(normalized)) return;
  const selfJids = [...state.selfJids, normalized].slice(-SELF_JID_CAP);
  await saveState({ selfJids });
}
