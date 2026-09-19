import { Boom } from "@hapi/boom";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidStatusBroadcast,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { mkdir } from "node:fs/promises";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { AUTH_DIR, WHATSAPP_CHUNK } from "./config.ts";

export type Incoming = {
  jid: string;
  text: string;
  id: string;
  ts: number;
  fromMe: boolean;
};

type StartOpts = {
  onMessage: (msg: Incoming) => Promise<void>;
  startedAtSec: number;
  getLastProcessedTs: () => Promise<number>;
  markProcessed: (ts: number) => Promise<void>;
};

const logger = pino({ level: "silent" });
const outboundIds = new Set<string>();
const OUTBOUND_CAP = 500;

let sock: WASocket | null = null;
let reconnecting = false;
let stopped = false;

function rememberOutbound(id: string | undefined | null): void {
  if (!id) return;
  outboundIds.add(id);
  if (outboundIds.size > OUTBOUND_CAP) {
    const first = outboundIds.values().next().value;
    if (first) outboundIds.delete(first);
  }
}

type ProtoMessage = NonNullable<WAMessage["message"]> & {
  viewOnceMessageV2Extension?: { message?: WAMessage["message"] };
  documentWithCaptionMessage?: { message?: WAMessage["message"] };
};

function unwrapMessage(msg: WAMessage["message"]): ProtoMessage | undefined {
  if (!msg) return undefined;
  const node = msg as ProtoMessage;
  if (node.ephemeralMessage?.message) return unwrapMessage(node.ephemeralMessage.message);
  if (node.viewOnceMessage?.message) return unwrapMessage(node.viewOnceMessage.message);
  if (node.viewOnceMessageV2?.message) return unwrapMessage(node.viewOnceMessageV2.message);
  if (node.viewOnceMessageV2Extension?.message) {
    return unwrapMessage(node.viewOnceMessageV2Extension.message);
  }
  if (node.documentWithCaptionMessage?.message) {
    return unwrapMessage(node.documentWithCaptionMessage.message);
  }
  return node;
}

export function extractText(message: WAMessage): string {
  const msg = unwrapMessage(message.message);
  if (!msg) return "";
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.buttonsResponseMessage?.selectedDisplayText ||
    msg.listResponseMessage?.title ||
    ""
  ).trim();
}

function meJids(socket: WASocket): Set<string> {
  const out = new Set<string>();
  const add = (jid?: string | null) => {
    if (!jid) return;
    out.add(jidNormalizedUser(jid));
  };
  const user = socket.user as { id?: string; lid?: string; jid?: string } | undefined;
  add(user?.id);
  add(user?.lid);
  add(user?.jid);
  return out;
}

function isSelfChat(socket: WASocket, remoteJid: string | null | undefined): boolean {
  if (!remoteJid) return false;
  if (isJidGroup(remoteJid) || isJidBroadcast(remoteJid) || isJidStatusBroadcast(remoteJid)) {
    return false;
  }
  if (remoteJid.endsWith("@newsletter") || remoteJid === "status@broadcast") return false;
  const remote = jidNormalizedUser(remoteJid);
  return meJids(socket).has(remote);
}

export function chunkText(text: string, limit = WHATSAPP_CHUNK): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let idx = rest.lastIndexOf("\n", limit);
    if (idx < Math.floor(limit * 0.5)) idx = limit;
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx).replace(/^\n/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function sendText(jid: string, text: string): Promise<void> {
  if (!sock) throw new Error("WhatsApp is not connected");
  const body = text.trim() || "(empty)";
  for (const part of chunkText(body)) {
    const sent = await sock.sendMessage(jid, { text: part });
    rememberOutbound(sent?.key?.id);
  }
}

async function connect(opts: StartOpts): Promise<void> {
  if (stopped) return;
  await mkdir(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: Browsers.ubuntu("Cursor Bridge"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });
  sock = socket;

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("Scan this QR in WhatsApp → Linked devices:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      reconnecting = false;
      const me = [...meJids(socket)].join(", ") || "(unknown)";
      console.log(`WhatsApp connected as ${me}`);
      console.log('Only the "Message yourself" chat is accepted.');
    }
    if (connection === "close") {
      sock = null;
      const status = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = status === DisconnectReason.loggedOut;
      if (loggedOut) {
        console.error("WhatsApp logged out. Delete the auth/ folder and restart to re-scan.");
        return;
      }
      if (stopped || reconnecting) return;
      reconnecting = true;
      const delay = 2000;
      console.log(`WhatsApp disconnected (status ${status ?? "?"}). Reconnecting…`);
      setTimeout(() => {
        reconnecting = false;
        void connect(opts).catch((err) => {
          console.error("Reconnect failed:", err);
        });
      }, delay);
    }
  });

  socket.ev.on("messages.upsert", async ({ messages }) => {
    for (const message of messages) {
      try {
        await handleIncoming(socket, message, opts);
      } catch (err) {
        console.error("Failed to handle message:", err);
      }
    }
  });
}

async function handleIncoming(socket: WASocket, message: WAMessage, opts: StartOpts): Promise<void> {
  const id = message.key.id;
  const remoteJid = message.key.remoteJid;
  const ts = Number(message.messageTimestamp || 0);
  if (!id || !remoteJid) return;
  if (outboundIds.has(id)) return;
  if (!isSelfChat(socket, remoteJid)) return;

  const lastTs = await opts.getLastProcessedTs();
  const cutoff = Math.max(opts.startedAtSec, lastTs);
  if (ts <= cutoff) return;

  const text = extractText(message);
  await opts.markProcessed(ts);
  if (!text) return;

  await opts.onMessage({
    jid: remoteJid,
    text,
    id,
    ts,
    fromMe: Boolean(message.key.fromMe),
  });
}

export async function startWhatsApp(opts: StartOpts): Promise<void> {
  stopped = false;
  await connect(opts);
}

export function stopWhatsApp(): void {
  stopped = true;
  try {
    sock?.end(undefined);
  } catch {
    // ignore
  }
  sock = null;
}

export function connectedAs(): string {
  if (!sock?.user) return "offline";
  return [...meJids(sock)].join(", ") || "online";
}
