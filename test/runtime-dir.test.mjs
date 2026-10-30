import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runtimeDir } from '../src/runtime-dir.mjs';

const ORIG_XDG = process.env.XDG_RUNTIME_DIR;
const ORIG_TMP = process.env.TMPDIR;
const UID = process.getuid();
let SANDBOX;

beforeEach(() => {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-self-mcp-rtdir-'));
  process.env.TMPDIR = path.join(SANDBOX, 'tmp');
});

afterEach(() => {
  if (ORIG_XDG === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = ORIG_XDG;
  if (ORIG_TMP === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = ORIG_TMP;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

describe('runtimeDir', () => {
  it('uses $XDG_RUNTIME_DIR when it is an existing writable dir', () => {
    process.env.XDG_RUNTIME_DIR = SANDBOX;
    assert.equal(runtimeDir(), path.join(SANDBOX, 'slack-self-mcp'));
  });

  it('falls back to tmpdir when $XDG_RUNTIME_DIR does not exist', () => {
    process.env.XDG_RUNTIME_DIR = path.join(SANDBOX, 'missing', '1000');
    assert.equal(runtimeDir(), path.join(SANDBOX, 'tmp', `slack-self-mcp-${UID}`));
  });

  it('falls back to tmpdir when $XDG_RUNTIME_DIR is not writable', () => {
    const ro = path.join(SANDBOX, 'ro');
    fs.mkdirSync(ro, { mode: 0o500 });
    process.env.XDG_RUNTIME_DIR = ro;
    const expected = UID === 0
      ? path.join(ro, 'slack-self-mcp')
      : path.join(SANDBOX, 'tmp', `slack-self-mcp-${UID}`);
    assert.equal(runtimeDir(), expected);
  });

  it('falls back to tmpdir when $XDG_RUNTIME_DIR is unset or relative', () => {
    delete process.env.XDG_RUNTIME_DIR;
    assert.equal(runtimeDir(), path.join(SANDBOX, 'tmp', `slack-self-mcp-${UID}`));
    process.env.XDG_RUNTIME_DIR = 'relative/dir';
    assert.equal(runtimeDir(), path.join(SANDBOX, 'tmp', `slack-self-mcp-${UID}`));
  });
});
