import { Boom } from "@hapi/boom";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  areJidsSameUser,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
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
import { loadState, rememberProcessedId, rememberSelfJid } from "./state.ts";

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
};

type MeContact = { id?: string; lid?: string; jid?: string };

const logger = pino({ level: "silent" });
const outboundIds = new Set<string>();
const outboundBodies = new Set<string>();
const OUTBOUND_CAP = 500;
const HISTORY_GRACE_SEC = 20;
const messageCache = new Map<string, NonNullable<WAMessage["message"]>>();

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
  const edited = node.protocolMessage?.editedMessage;
  if (edited) return unwrapMessage(edited);
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

function messageTs(message: WAMessage): number {
  const t = message.messageTimestamp as unknown;
  if (typeof t === "number") return t;
  if (typeof t === "bigint") return Number(t);
  if (t && typeof t === "object" && "toNumber" in t && typeof t.toNumber === "function") {
    return t.toNumber();
  }
  return 0;
}

function meIdentities(socket: WASocket): string[] {
  const user = socket.user as MeContact | undefined;
  const me = socket.authState?.creds?.me as MeContact | undefined;
  const ids = [user?.id, user?.lid, user?.jid, me?.id, me?.lid, me?.jid];
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

function isIgnoredChat(remoteJid: string): boolean {
  return (
    isJidGroup(remoteJid) ||
    isJidBroadcast(remoteJid) ||
    isJidStatusBroadcast(remoteJid) ||
    isJidNewsletter(remoteJid) ||
    remoteJid === "status@broadcast"
  );
}

function isSelfChat(socket: WASocket, message: WAMessage, learned: string[]): boolean {
  const remoteJid = message.key.remoteJid;
  if (!remoteJid || isIgnoredChat(remoteJid)) return false;

  const identities = [...meIdentities(socket), ...learned];
  for (const me of identities) {
    if (areJidsSameUser(remoteJid, me)) return true;
    if (jidNormalizedUser(remoteJid) === jidNormalizedUser(me)) return true;
  }

  const senderLid = message.key.senderLid;
  // Note-to-self over LID: chat JID is our own LID, which may be unknown at startup.
  if (message.key.fromMe && senderLid && areJidsSameUser(remoteJid, senderLid)) return true;

  return false;
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
  outboundBodies.add(body);
  setTimeout(() => outboundBodies.delete(body), 60_000).unref();
  for (const part of chunkText(body)) {
    outboundBodies.add(part);
    setTimeout(() => outboundBodies.delete(part), 60_000).unref();
    const sent = await sock.sendMessage(jid, { text: part });
    rememberOutbound(sent?.key?.id);
  }
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 77)}...`;
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
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: false,
    markOnlineOnConnect: true,
    getMessage: async (key) => {
      if (!key.id) return undefined;
      return messageCache.get(key.id);
    },
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
      const me = meIdentities(socket).join(", ") || "(unknown)";
      console.log(`WhatsApp connected as ${me}`);
      console.log('Send a prompt in "Message yourself". Terminal will log every inbound chat.');
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
      const delay = status === 515 ? 1000 : 2000;
      console.log(`WhatsApp disconnected (status ${status ?? "?"}). Reconnecting…`);
      setTimeout(() => {
        reconnecting = false;
        void connect(opts).catch((err) => {
          console.error("Reconnect failed:", err);
        });
      }, delay);
    }
  });

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const message of messages) {
      try {
        await handleIncoming(socket, message, opts, type);
      } catch (err) {
        console.error("Failed to handle message:", err);
      }
    }
  });

  socket.ev.on("messages.update", async (updates) => {
    for (const { key, update } of updates) {
      if (!update.message) continue;
      const message: WAMessage = {
        key,
        message: update.message,
        messageTimestamp: Math.floor(Date.now() / 1000),
      };
      try {
        await handleIncoming(socket, message, opts, "update");
      } catch (err) {
        console.error("Failed to handle message update:", err);
      }
    }
  });
}

async function handleIncoming(
  socket: WASocket,
  message: WAMessage,
  opts: StartOpts,
  source: string,
): Promise<void> {
  const id = message.key.id;
  const remoteJid = message.key.remoteJid;
  const ts = messageTs(message);
  const fromMe = Boolean(message.key.fromMe);
  const text = extractText(message);

  if (message.message && id) {
    messageCache.set(id, message.message);
  }

  if (!id || !remoteJid) {
    console.log(`recv ${source} skip=no-id jid=${remoteJid ?? "?"}`);
    return;
  }
  if (outboundIds.has(id)) return;
  if (fromMe && text && outboundBodies.has(text)) {
    rememberOutbound(id);
    return;
  }

  const state = await loadState();
  if (state.processedIds.includes(id)) return;

  if (isIgnoredChat(remoteJid)) return;

  const self = isSelfChat(socket, message, state.selfJids);
  console.log(
    `recv ${source} fromMe=${fromMe} jid=${jidNormalizedUser(remoteJid) || remoteJid}` +
      `${message.key.senderLid ? ` lid=${message.key.senderLid}` : ""}` +
      ` ts=${ts} self=${self} text="${preview(text)}"`,
  );

  if (!self) return;

  if (ts && ts < opts.startedAtSec - HISTORY_GRACE_SEC) {
    console.log(`skip ${id}: older than session start`);
    return;
  }

  if (!text) {
    console.log(`skip ${id}: no text payload (waiting for decrypt/update)`);
    return;
  }

  await rememberProcessedId(id);
  await rememberSelfJid(jidNormalizedUser(remoteJid) || remoteJid);
  if (message.key.senderLid) await rememberSelfJid(jidNormalizedUser(message.key.senderLid));

  await opts.onMessage({
    jid: remoteJid,
    text,
    id,
    ts,
    fromMe,
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
  return meIdentities(sock).join(", ") || "online";
}
