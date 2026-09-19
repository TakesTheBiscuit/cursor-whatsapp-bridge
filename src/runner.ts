import { spawn, type ChildProcess } from "node:child_process";
import {
  CURSOR_API_KEY,
  CURSOR_BIN,
  CURSOR_MODEL,
  WORKSPACE_PATH,
} from "./config.ts";
import { appendThread, loadState, saveState } from "./state.ts";

const PROMPT_PREFIX = `You are being driven via WhatsApp. Reply with a concise human-readable status (what you did, what to do next). Do not dump full file contents or verbose logs. Prefer a short diff/summary.

User message:
`;

export type Job = {
  prompt: string;
  reply: (text: string) => Promise<void>;
};

function lastUsefulLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) || text.trim() || "unknown error";
}

function parseAgentStdout(stdout: string): { result: string; session_id?: string } {
  const trimmed = stdout.trim();
  const tryParse = (raw: string) => {
    const obj = JSON.parse(raw) as { result?: unknown; session_id?: unknown };
    if (typeof obj.result === "string") {
      return {
        result: obj.result,
        session_id: typeof obj.session_id === "string" ? obj.session_id : undefined,
      };
    }
    return null;
  };

  try {
    const parsed = tryParse(trimmed);
    if (parsed) return parsed;
  } catch {
    // fall through to last JSON line
  }

  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const parsed = tryParse(s);
      if (parsed) return parsed;
    } catch {
      // keep scanning
    }
  }

  throw new Error(lastUsefulLine(trimmed) || "agent produced no JSON result");
}

type RunHandle = {
  get proc(): ChildProcess | null;
  done: Promise<{ stdout: string; stderr: string; code: number }>;
};

function runChild(args: string[]): RunHandle {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (CURSOR_API_KEY) env.CURSOR_API_KEY = CURSOR_API_KEY;

  const bins = CURSOR_BIN ? [CURSOR_BIN] : ["agent", "cursor-agent"];
  let index = 0;
  let proc: ChildProcess | null = spawn(bins[index], args, {
    env,
    cwd: WORKSPACE_PATH,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const done = new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    let settled = false;
    const attach = (child: ChildProcess) => {
      let stdout = "";
      let stderr = "";
      let ignoreClose = false;

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT" && index < bins.length - 1) {
          ignoreClose = true;
          index += 1;
          proc = spawn(bins[index], args, {
            env,
            cwd: WORKSPACE_PATH,
            stdio: ["ignore", "pipe", "pipe"],
          });
          attach(proc);
          return;
        }
        proc = null;
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      child.on("close", (code) => {
        if (ignoreClose || settled) return;
        settled = true;
        proc = null;
        resolve({ stdout, stderr, code: code ?? 1 });
      });
    };

    if (proc) attach(proc);
  });

  return {
    get proc() {
      return proc;
    },
    done,
  };
}

export class Runner {
  private queue: Job[] = [];
  private draining = false;
  private handle: RunHandle | null = null;
  private cancelled = false;

  get queueLength(): number {
    return this.queue.length;
  }

  get busy(): boolean {
    return this.draining || this.handle !== null;
  }

  enqueue(job: Job): void {
    this.queue.push(job);
    void this.drain();
  }

  async cancel(): Promise<boolean> {
    const child = this.handle?.proc;
    if (!child) return false;
    this.cancelled = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 3000).unref();
    return true;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    await saveState({ status: "busy" });
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        if (!job) break;
        await this.run(job);
      }
    } finally {
      this.draining = false;
      this.handle = null;
      await saveState({ status: "idle" });
    }
  }

  private async run(job: Job): Promise<void> {
    this.cancelled = false;
    await appendThread("user", job.prompt);
    const state = await loadState();

    const args = [
      "-p",
      "--force",
      "--trust",
      "--workspace",
      WORKSPACE_PATH,
      "--output-format",
      "json",
    ];
    if (state.sessionId) {
      args.push("--resume", state.sessionId);
    }
    if (CURSOR_MODEL) {
      args.push("--model", CURSOR_MODEL);
    }
    args.push(`${PROMPT_PREFIX}${job.prompt}`);

    const handle = runChild(args);
    this.handle = handle;

    let stdout = "";
    let stderr = "";
    let code = 1;
    try {
      ({ stdout, stderr, code } = await handle.done);
    } catch (err) {
      this.handle = null;
      const message =
        err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"
          ? "Cursor CLI not found. Install it (`curl https://cursor.com/install -fsS | bash`) and ensure `agent` is on PATH."
          : err instanceof Error
            ? err.message
            : "failed to start agent";
      await appendThread("system", message);
      await job.reply(`Agent failed: ${message}`);
      return;
    } finally {
      this.handle = null;
    }

    if (this.cancelled) {
      const message = "Cancelled.";
      await appendThread("system", message);
      await job.reply(message);
      return;
    }

    if (code !== 0) {
      const message = lastUsefulLine(stderr || stdout);
      await appendThread("system", message);
      await job.reply(`Agent failed: ${message}`);
      return;
    }

    try {
      const parsed = parseAgentStdout(stdout);
      if (parsed.session_id) {
        await saveState({ sessionId: parsed.session_id });
      }
      const text = parsed.result.trim() || "(agent finished with an empty reply)";
      await appendThread("assistant", text);
      await job.reply(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : "could not parse agent output";
      await appendThread("system", message);
      await job.reply(`Agent failed: ${message}`);
    }
  }
}
