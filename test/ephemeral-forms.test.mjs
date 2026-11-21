import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const ORIG_XDG = process.env.XDG_RUNTIME_DIR;
let SANDBOX;
let mod;

beforeEach(async () => {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mcp-test-'));
  process.env.XDG_RUNTIME_DIR = SANDBOX;
  mod = await import(`../src/ephemeral-forms.mjs?b=${Date.now()}-${Math.random()}`);
});

afterEach(() => {
  if (ORIG_XDG === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = ORIG_XDG;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

describe('ephemeral forms', () => {
  const form = (ts) => ({ message_ts: ts, channel: 'D1', text: 'pick', blocks: [{ type: 'actions', block_id: 'buttons', elements: [] }] });

  it('finds a saved form by message ts, in a 0600 file', () => {
    mod.recordEphemeralForm(form('1.1'));
    mod.recordEphemeralForm(form('2.2'));
    assert.deepEqual(mod.findEphemeralForm('2.2').blocks, form('2.2').blocks);
    assert.equal(mod.findEphemeralForm('3.3'), null);
    assert.equal(fs.statSync(mod.ephemeralFormsPath()).mode & 0o777, 0o600);
  });

  it('forgets forms older than a day', () => {
    const now = Date.now();
    mod.recordEphemeralForm(form('1.1'), now - 25 * 3600 * 1000);
    assert.equal(mod.findEphemeralForm('1.1', now), null);
    mod.recordEphemeralForm(form('2.2'), now);
    assert.equal(fs.readFileSync(mod.ephemeralFormsPath(), 'utf8').includes('1.1'), false);
  });

  it('returns null before anything was saved', () => {
    assert.equal(mod.findEphemeralForm('1.1'), null);
  });
});
