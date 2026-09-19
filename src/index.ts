import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { LOCK_PATH, WORKSPACE_PATH, assertWorkspace } from "./config.ts";
import { Runner } from "./runner.ts";
import { loadState, saveState } from "./state.ts";
import { connectedAs, sendText, startWhatsApp, stopWhatsApp } from "./whatsapp.ts";

const HELP = `Commands:
/help — this text
/status — idle/busy, queue, session
/new — start a fresh Cursor chat (next prompt is a new session)
/cancel — stop the current agent run

Anything else is sent to Cursor. Smoke test: "do not edit files, just reply pong"`;

function acquireLock(): void {
  if (existsSync(LOCK_PATH)) {
    const raw = readFileSync(LOCK_PATH, "utf8").trim();
    const pid = Number(raw);
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        throw new Error(`Already running (pid ${pid}). If not, delete .agent.lock and retry.`);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") throw err;
      }
    }
  }
  writeFileSync(LOCK_PATH, `${process.pid}\n`, "utf8");
}

function releaseLock(): void {
  try {
    if (!existsSync(LOCK_PATH)) return;
    const raw = readFileSync(LOCK_PATH, "utf8").trim();
    if (raw && raw !== String(process.pid)) return;
    unlinkSync(LOCK_PATH);
  } catch {
    // ignore
  }
}

function shortSession(id: string | null): string {
  if (!id) return "(none)";
  return id.length <= 12 ? id : `${id.slice(0, 8)}…`;
}

async function main(): Promise<void> {
  assertWorkspace();
  acquireLock();
  const startedAtSec = Math.floor(Date.now() / 1000);
  const runner = new Runner();

  const shutdown = () => {
    stopWhatsApp();
    void runner.cancel();
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`Workspace: ${WORKSPACE_PATH}`);
  await startWhatsApp({
    startedAtSec,
    getLastProcessedTs: async () => (await loadState()).lastProcessedTs,
    markProcessed: async (ts) => {
      const state = await loadState();
      if (ts > state.lastProcessedTs) await saveState({ lastProcessedTs: ts });
    },
    onMessage: async (msg) => {
      const text = msg.text.trim();
      const reply = (body: string) => sendText(msg.jid, body);

      if (text === "/help") {
        await reply(HELP);
        return;
      }
      if (text === "/status") {
        const state = await loadState();
        const lines = [
          `status: ${runner.busy ? "busy" : "idle"}`,
          `queue: ${runner.queueLength}`,
          `session: ${shortSession(state.sessionId)}`,
          `whatsapp: ${connectedAs()}`,
          `workspace: ${WORKSPACE_PATH}`,
        ];
        await reply(lines.join("\n"));
        return;
      }
      if (text === "/new") {
        await saveState({ sessionId: null });
        await reply("Next prompt starts a fresh Cursor chat.");
        return;
      }
      if (text === "/cancel") {
        const killed = await runner.cancel();
        await reply(killed ? "Cancelling current run…" : "Nothing to cancel.");
        return;
      }

      const ahead = runner.busy ? runner.queueLength + 1 : 0;
      runner.enqueue({
        prompt: text,
        reply,
      });
      if (ahead > 0) {
        await reply(`Queued (${ahead} ahead).`);
      } else {
        await reply("On it.");
      }
    },
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  releaseLock();
  process.exit(1);
});
