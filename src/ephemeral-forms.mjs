// Ephemeral messages with buttons, saved so the listener can replace one after
// a click: Slack's click payload for an ephemeral message leaves the message
// out. Slack drops an ephemeral message when the page reloads, so a day is
// more than any of them lasts.

import fs from 'node:fs';
import path from 'node:path';

import { runtimeDir } from './runtime-dir.mjs';

const TTL_MS = 24 * 60 * 60 * 1000;

export function ephemeralFormsPath() {
  return path.join(runtimeDir(), 'ephemeral-forms.jsonl');
}

function readFresh(now) {
  let raw;
  try {
    raw = fs.readFileSync(ephemeralFormsPath(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.saved_at >= now - TTL_MS) out.push(e);
    } catch { /* skip a torn line */ }
  }
  return out;
}

// Rewrites the file without expired entries, through tmp+rename.
export function recordEphemeralForm({ message_ts, channel, text, blocks }, now = Date.now()) {
  const dir = runtimeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const entries = [...readFresh(now), { message_ts, channel, text, blocks, saved_at: now }];
  const target = ephemeralFormsPath();
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function findEphemeralForm(message_ts, now = Date.now()) {
  return readFresh(now).find((e) => e.message_ts === message_ts) ?? null;
}
