# cursor-whatsapp-bridge

Tiny local daemon: message yourself on WhatsApp, Cursor CLI works the repo, you get a reply when the run finishes.

This does **not** inject into the Cursor desktop chat panel. It runs `agent -p` against the same files the IDE has open. Come back later and the diffs are on disk.

## Prerequisites

- Node.js 20+
- Cursor CLI in this same environment (WSL if the repo lives in WSL):

```bash
curl https://cursor.com/install -fsS | bash
agent login
# or set CURSOR_API_KEY in .env — https://cursor.com/dashboard/integrations
```

Confirm `agent --version` works in the same shell you will use for `npm start`.

## Setup

```bash
cp .env.example .env
# optional: CURSOR_API_KEY, CURSOR_MODEL, WORKSPACE_PATH
npm install
npm start
```

Scan the QR code: WhatsApp → Settings → Linked devices.

Auth is stored in `auth/` (gitignored). You only scan once until you log that device out.

## Smoke test

In WhatsApp, open **Message yourself** and send:

```text
do not edit files, just reply pong
```

You should get `On it.` then a short Cursor reply. Only that chat is accepted; groups and other people are ignored.

## Commands

| Command | What it does |
| --- | --- |
| `/help` | List commands |
| `/status` | Idle/busy, run duration, queue, current prompt |
| `/new` | Forget the Cursor session; next prompt starts fresh |
| `/cancel` | Kill the in-flight `agent` process |
| `/nudge` | Kill a stuck run and send Cursor a wake-up/status prompt |

`status`, `help`, `new`, `cancel`, and `nudge` also work without the slash, as long as that is the whole message. Anything else is queued and sent to Cursor.

If a run stays busy with at least one prompt waiting for 10 minutes (`STUCK_MINUTES` in `.env`), the daemon kills that `agent` process and auto-queues a short wake-up prompt so you get a status instead of a silent hang. After two nudges it gives up and tells you.

Follow-ups `--resume` the same CLI session so context sticks. While a run is in progress, later messages wait in order instead of overlapping.

## Point it at another repo

After the loop works, set `WORKSPACE_PATH` in `.env` to the long-running project. No code change.

## Notes

- `--force` is on so the agent can edit unattended. Keep this as a personal self-chat only.
- Baileys talks to WhatsApp as a linked device (same class as WhatsApp Web). Personal use; don't spam.
- `.env`, `auth/`, and `data/` are not committed.
