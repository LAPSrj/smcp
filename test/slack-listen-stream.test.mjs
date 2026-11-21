// Tests for the per-agent stream binary (scripts/slack-listen-stream.mjs).
// Pure-function tests for parseArgs + passesFilters; one end-to-end test
// of the tail+filter loop via child_process against a temp events.jsonl
// (no singleton involved — --events-file overrides the path).

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const STREAM_PATH = path.join(REPO_ROOT, 'scripts', 'slack-listen-stream.mjs');

const ORIG_XDG = process.env.XDG_RUNTIME_DIR;
let SANDBOX;
let mod;

beforeEach(async () => {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-stream-test-'));
  process.env.XDG_RUNTIME_DIR = SANDBOX;
  const cacheBust = `?b=${Date.now()}-${Math.random()}`;
  mod = await import(`../scripts/slack-listen-stream.mjs${cacheBust}`);
});

afterEach(() => {
  if (ORIG_XDG === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = ORIG_XDG;
  if (SANDBOX) fs.rmSync(SANDBOX, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('returns defaults when no flags given', () => {
    const flags = mod.parseArgs(['node', 'stream.mjs']);
    assert.deepEqual(flags, {
      watchSelf: false, includeSubtypes: false,
      channel: null, thread: null, eventsFile: null,
    });
  });

  it('--watch-self sets watchSelf:true', () => {
    const flags = mod.parseArgs(['node', 'stream.mjs', '--watch-self']);
    assert.equal(flags.watchSelf, true);
  });

  it('--no-self explicitly leaves watchSelf:false', () => {
    const flags = mod.parseArgs(['node', 'stream.mjs', '--watch-self', '--no-self']);
    assert.equal(flags.watchSelf, false);
  });

  it('--include-subtypes / --channel / --thread / --events-file all parse', () => {
    const flags = mod.parseArgs([
      'node', 'stream.mjs',
      '--include-subtypes',
      '--channel', 'C0123',
      '--thread', '1234.5678',
      '--events-file', '/tmp/events.jsonl',
    ]);
    assert.equal(flags.includeSubtypes, true);
    assert.equal(flags.channel, 'C0123');
    assert.equal(flags.thread, '1234.5678');
    assert.equal(flags.eventsFile, '/tmp/events.jsonl');
  });
});

describe('passesFilters', () => {
  const baseEvent = {
    ts: '1.1', channel: 'C1', user: 'U1', is_self: false,
    text: 'hi', thread_ts: null, subtype: null, bot_id: null,
  };
  const defaults = { watchSelf: false, includeSubtypes: false, channel: null, thread: null };

  it('synthetic events always pass through any filter', () => {
    const synth = { event: 'slack_disconnected', at: 12345 };
    assert.equal(mod.passesFilters(synth, defaults), true);
    assert.equal(mod.passesFilters(synth, { ...defaults, channel: 'C9' }), true);
    assert.equal(mod.passesFilters(synth, { ...defaults, thread: 'never' }), true);
  });

  it('drops malformed/empty events', () => {
    assert.equal(mod.passesFilters(null, defaults), false);
    assert.equal(mod.passesFilters({}, defaults), false);
    assert.equal(mod.passesFilters({ ts: null }, defaults), false);
  });

  it('default: drops is_self:true events', () => {
    const selfEvent = { ...baseEvent, is_self: true };
    assert.equal(mod.passesFilters(selfEvent, defaults), false);
  });

  it('keeps the human\'s own button clicks without --watch-self, still filtered by channel', () => {
    const click = { ...baseEvent, kind: 'button_click', is_self: true, action_id: 'approve' };
    assert.equal(mod.passesFilters(click, defaults), true);
    assert.equal(mod.passesFilters(click, { ...defaults, channel: 'C9' }), false);
  });

  it('--watch-self: keeps is_self:true events', () => {
    const selfEvent = { ...baseEvent, is_self: true };
    assert.equal(mod.passesFilters(selfEvent, { ...defaults, watchSelf: true }), true);
  });

  it('default: drops subtype-bearing events', () => {
    const editEvent = { ...baseEvent, subtype: 'message_changed' };
    assert.equal(mod.passesFilters(editEvent, defaults), false);
  });

  it('default: drops bot_id-bearing events (treated like subtypes)', () => {
    const botEvent = { ...baseEvent, bot_id: 'B123' };
    assert.equal(mod.passesFilters(botEvent, defaults), false);
  });

  it('own bot posts follow the self filter, not the subtype filter', () => {
    const ownBot = { ...baseEvent, bot_id: 'B123', is_self: true };
    assert.equal(mod.passesFilters(ownBot, defaults), false);
    assert.equal(mod.passesFilters(ownBot, { ...defaults, watchSelf: true }), true);
    const ownBotOverride = { ...ownBot, subtype: 'bot_message' };
    assert.equal(mod.passesFilters(ownBotOverride, { ...defaults, watchSelf: true }), true);
    const ownBotEdit = { ...ownBot, subtype: 'message_changed' };
    assert.equal(mod.passesFilters(ownBotEdit, { ...defaults, watchSelf: true }), false);
  });

  it('default: keeps messages people write that carry a subtype', () => {
    for (const subtype of ['file_share', 'thread_broadcast', 'me_message']) {
      assert.equal(mod.passesFilters({ ...baseEvent, subtype }, defaults), true, subtype);
    }
    assert.equal(mod.passesFilters({ ...baseEvent, subtype: 'channel_join' }, defaults), false);
    assert.equal(mod.passesFilters({ ...baseEvent, subtype: 'file_share', bot_id: 'B123' }, defaults), false);
  });

  it('--include-subtypes: keeps subtype + bot_id events', () => {
    const editEvent = { ...baseEvent, subtype: 'message_changed' };
    const botEvent = { ...baseEvent, bot_id: 'B123' };
    assert.equal(mod.passesFilters(editEvent, { ...defaults, includeSubtypes: true }), true);
    assert.equal(mod.passesFilters(botEvent, { ...defaults, includeSubtypes: true }), true);
  });

  it('--channel filter drops other-channel events', () => {
    const evC1 = { ...baseEvent, channel: 'C1' };
    const evC2 = { ...baseEvent, channel: 'C2' };
    assert.equal(mod.passesFilters(evC1, { ...defaults, channel: 'C1' }), true);
    assert.equal(mod.passesFilters(evC2, { ...defaults, channel: 'C1' }), false);
  });

  it('--thread filter matches both replies (thread_ts) and the parent (ts)', () => {
    const parent = { ...baseEvent, ts: '100.0', thread_ts: null };
    const reply  = { ...baseEvent, ts: '101.0', thread_ts: '100.0' };
    const otherThread = { ...baseEvent, ts: '102.0', thread_ts: '999.0' };
    const flags = { ...defaults, thread: '100.0' };
    assert.equal(mod.passesFilters(parent, flags), true);
    assert.equal(mod.passesFilters(reply, flags), true);
    assert.equal(mod.passesFilters(otherThread, flags), false);
  });

  it('filters compose (channel + thread + watchSelf)', () => {
    const matching = { ...baseEvent, channel: 'C1', thread_ts: 'T1', is_self: true };
    const wrongChannel = { ...matching, channel: 'C2' };
    const wrongThread = { ...matching, thread_ts: 'T2' };
    const flags = { watchSelf: true, includeSubtypes: false, channel: 'C1', thread: 'T1' };
    assert.equal(mod.passesFilters(matching, flags), true);
    assert.equal(mod.passesFilters(wrongChannel, flags), false);
    assert.equal(mod.passesFilters(wrongThread, flags), false);
  });
});

// End-to-end: spawn the stream binary, point it at a temp events.jsonl,
// write events, verify it tails + filters them. Uses a stubbed singleton
// (an env that points ensureRunning at a stub script that immediately
// writes a heartbeat then sleeps).
describe('tail integration (e2e via child_process)', () => {
  function stubSingletonScript(sandbox) {
    const stubPath = path.join(sandbox, 'stub-singleton.mjs');
    const helperUrl = new URL('../src/listener-singleton.mjs', import.meta.url).href;
    fs.writeFileSync(stubPath, `
import { writeHeartbeat, writePidFile } from '${helperUrl}';
writePidFile();
writeHeartbeat();
setInterval(writeHeartbeat, 5000).unref();
await new Promise(r => setTimeout(r, 60000));
`);
    return stubPath;
  }

  it('emits matching events, drops non-matching, includes synthetic events', async () => {
    const eventsFile = path.join(SANDBOX, 'events.jsonl');
    fs.writeFileSync(eventsFile, '', { mode: 0o600 });

    // Pre-spawn a stub singleton heartbeat so ensureRunning short-circuits
    // to alreadyRunning and the stream binary doesn't try to spawn the real one.
    const stubPath = stubSingletonScript(SANDBOX);
    const stubProc = spawn(process.execPath, [stubPath], {
      env: { ...process.env, XDG_RUNTIME_DIR: SANDBOX },
      detached: true, stdio: 'ignore',
    });
    stubProc.unref();
    // Tiny wait so heartbeat lands before stream binary boots.
    await new Promise((r) => setTimeout(r, 200));

    const child = spawn(process.execPath, [
      STREAM_PATH,
      '--watch-self',
      '--channel', 'C1',
      '--events-file', eventsFile,
    ], {
      env: { ...process.env, XDG_RUNTIME_DIR: SANDBOX },
    });

    let stdoutBuf = '';
    child.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    let stderrBuf = '';
    child.stderr.on('data', (c) => { stderrBuf += c.toString(); });

    // Wait for stream binary to be tailing.
    await new Promise((r) => setTimeout(r, 600));

    // Append a mix.
    fs.appendFileSync(eventsFile,
      JSON.stringify({ ts: '1.1', channel: 'C1', user: 'U1', is_self: false, text: 'hi', subtype: null, thread_ts: null, bot_id: null }) + '\n' +
      JSON.stringify({ ts: '2.2', channel: 'C2', user: 'U1', is_self: false, text: 'wrong channel', subtype: null, thread_ts: null, bot_id: null }) + '\n' +
      JSON.stringify({ ts: '3.3', channel: 'C1', user: 'U_SELF', is_self: true, text: 'self in C1', subtype: null, thread_ts: null, bot_id: null }) + '\n' +
      JSON.stringify({ event: 'slack_disconnected', at: 12345 }) + '\n' +
      JSON.stringify({ ts: '4.4', channel: 'C1', user: 'U2', is_self: false, text: 'edit', subtype: 'message_changed', thread_ts: null, bot_id: null }) + '\n',
    );

    // Wait for poll + emit.
    await new Promise((r) => setTimeout(r, 800));

    child.kill('SIGTERM');
    stubProc.kill('SIGTERM');

    const lines = stdoutBuf.trim().split('\n').filter(Boolean).map(JSON.parse);
    // Expect: ts=1.1 (C1, not self), ts=3.3 (C1, self+watchSelf), synthetic disconnect.
    // Dropped: ts=2.2 (wrong channel), ts=4.4 (subtype).
    const tsOrEvent = lines.map((l) => l.ts ?? l.event);
    assert.deepEqual(tsOrEvent.sort(), ['1.1', '3.3', 'slack_disconnected'].sort(),
      `unexpected stdout. stderr was: ${stderrBuf}\nstdout was: ${stdoutBuf}`);
  });

  it('exits 1 when the events file cannot be reopened after a rotation', { skip: process.getuid?.() === 0 && 'root can open a 000 file' }, async () => {
    const eventsFile = path.join(SANDBOX, 'events.jsonl');
    fs.writeFileSync(eventsFile, '', { mode: 0o600 });
    const stubPath = stubSingletonScript(SANDBOX);
    const stubProc = spawn(process.execPath, [stubPath], {
      env: { ...process.env, XDG_RUNTIME_DIR: SANDBOX },
      detached: true, stdio: 'ignore',
    });
    stubProc.unref();
    await new Promise((r) => setTimeout(r, 200));

    const child = spawn(process.execPath, [STREAM_PATH, '--events-file', eventsFile], {
      env: { ...process.env, XDG_RUNTIME_DIR: SANDBOX },
    });
    let stderrBuf = '';
    child.stderr.on('data', (c) => { stderrBuf += c.toString(); });
    const exited = new Promise((r) => child.on('exit', (code) => r(code)));
    await new Promise((r) => setTimeout(r, 600));

    fs.renameSync(eventsFile, path.join(SANDBOX, 'events.1.jsonl'));
    fs.writeFileSync(eventsFile, '', { mode: 0o000 });
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 1500))]);
    if (code === 'still running') child.kill('SIGTERM');
    stubProc.kill('SIGTERM');
    assert.equal(code, 1, `stderr was: ${stderrBuf}`);
  });
});

describe('keepListenerRunning', () => {
  it('starts a new listener after the running one exits', async () => {
    const helperUrl = new URL('../src/listener-singleton.mjs', import.meta.url).href;
    const stubPath = path.join(SANDBOX, 'stub-short-lived.mjs');
    fs.writeFileSync(stubPath, `
import { writeHeartbeat, writePidFile, clearSingletonFiles } from '${helperUrl}';
writePidFile();
writeHeartbeat();
await new Promise(r => setTimeout(r, 300));
clearSingletonFiles();
`);
    const pidFile = path.join(SANDBOX, 'slack-mcp', 'listener.pid');
    const readPid = () => { try { return fs.readFileSync(pidFile, 'utf8').trim(); } catch { return null; } };
    const waitFor = async (pred, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const v = pred();
        if (v) return v;
        await new Promise(r => setTimeout(r, 20));
      }
      return null;
    };

    const stop = mod.keepListenerRunning({ intervalMs: 50, singletonPath: stubPath });
    try {
      const first = await waitFor(readPid, 3000);
      assert.ok(first, 'first listener never started');
      const second = await waitFor(() => { const p = readPid(); return p && p !== first ? p : null; }, 3000);
      assert.ok(second, 'no new listener after the first one exited');
    } finally {
      stop();
    }
    await new Promise(r => setTimeout(r, 400));
  });
});

describe('tailLoop rotation (in-process)', () => {
  it('keeps a line appended to the old file between the empty read and the rotation check', async () => {
    const eventsFile = path.join(SANDBOX, 'events.jsonl');
    fs.writeFileSync(eventsFile, '', { mode: 0o600 });
    const line = (ts) => JSON.stringify({ ts, channel: 'C1', user: 'U1', is_self: false, text: ts, subtype: null, thread_ts: null, bot_id: null }) + '\n';

    // Act as the listener at the worst moment: after the tail read 0 bytes and
    // before it stats the path, append one line to the old file, rotate, and
    // append the next line to the new file.
    const realStat = fs.statSync;
    fs.statSync = (p, ...rest) => {
      if (p === eventsFile) {
        fs.statSync = realStat;
        fs.appendFileSync(eventsFile, line('1.1'));
        fs.renameSync(eventsFile, path.join(SANDBOX, 'events.1.jsonl'));
        fs.appendFileSync(eventsFile, line('2.2'));
      }
      return realStat(p, ...rest);
    };

    const seen = [];
    const stop = mod.tailLoop(eventsFile, { watchSelf: false, includeSubtypes: false }, (_l, ev) => seen.push(ev.ts));
    try {
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      fs.statSync = realStat;
      stop();
    }
    assert.deepEqual(seen, ['1.1', '2.2']);
  });
});
