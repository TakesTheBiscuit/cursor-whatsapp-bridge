import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { LOCK_PATH, STUCK_MS, WORKSPACE_PATH, assertWorkspace } from "./config.ts";
import { Runner } from "./runner.ts";
import { loadState, saveState } from "./state.ts";
import { connectedAs, sendText, startWhatsApp, stopWhatsApp } from "./whatsapp.ts";

const HELP = `Commands:
/help — this text
/status — idle/busy, queue, how long the current run has been going
/new — start a fresh Cursor chat (next prompt is a new session)
/cancel — stop the current agent run
/nudge — kill a stuck run and ask Cursor for a wake-up/status

status, help, new, cancel, nudge also work without the slash.

Anything else is sent to Cursor. Smoke test: "do not edit files, just reply pong"`;

const COMMANDS = new Set(["help", "status", "new", "cancel", "nudge"]);

function parseCommand(text: string): string | null {
  const cleaned = text.replace(/[\u200b-\u200d\ufeff]/g, "").trim();
  const match = cleaned.match(/^[/\uFF0F]?([A-Za-z]+)\s*$/);
  if (!match) return null;
  const cmd = match[1].toLowerCase();
  return COMMANDS.has(cmd) ? cmd : null;
}

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

function preview(text: string | null): string {
  if (!text) return "(none)";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 77)}...`;
}

function formatMs(ms: number | null): string {
  if (ms == null) return "(not running)";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (m <= 0) return `${s}s`;
  return `${m}m ${s}s`;
}

async function main(): Promise<void> {
  assertWorkspace();
  acquireLock();
  const startedAtSec = Math.floor(Date.now() / 1000);
  const runner = new Runner();

  const shutdown = () => {
    runner.stop();
    stopWhatsApp();
    void runner.cancel("user");
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`Workspace: ${WORKSPACE_PATH}`);
  console.log(`Stuck watchdog: ${Math.round(STUCK_MS / 60000)}m if queue is waiting`);
  await startWhatsApp({
    startedAtSec,
    onMessage: async (msg) => {
      const text = msg.text.trim();
      const reply = (body: string) => sendText(msg.jid, body);
      const command = parseCommand(text);

      if (command === "help") {
        await reply(HELP);
        return;
      }
      if (command === "status") {
        const state = await loadState();
        const snap = runner.snapshot();
        const lines = [
          `status: ${snap.busy ? "busy" : "idle"}`,
          `running: ${formatMs(snap.runningMs)}`,
          `queue: ${snap.queueLength}`,
          `nudges: ${snap.nudgesThisRun}`,
          `current: ${preview(snap.currentPrompt)}`,
          `session: ${shortSession(state.sessionId)}`,
          `whatsapp: ${connectedAs()}`,
          `workspace: ${WORKSPACE_PATH}`,
        ];
        await reply(lines.join("\n"));
        return;
      }
      if (command === "new") {
        await saveState({ sessionId: null });
        await reply("Next prompt starts a fresh Cursor chat.");
        return;
      }
      if (command === "cancel") {
        const killed = await runner.cancel("user");
        await reply(killed ? "Cancelling current run…" : "Nothing to cancel.");
        return;
      }
      if (command === "nudge") {
        const nudged = await runner.nudge(true);
        await reply(nudged ? "Nudging stuck Cursor run…" : "Nothing to nudge.");
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
