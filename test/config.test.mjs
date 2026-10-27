// Tests for src/config.mjs: token and setting lookup from env, the repo .env,
// and ~/.config/slack-self-mcp/. Every test passes its own env object and
// paths, so nothing reads the real .env or home config.

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { loadConfig, missingTokenHelp, tokenFilePath } from '../src/config.mjs';

let SANDBOX;
let envFile;
let configDir;

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-self-mcp-config-'));
  envFile = path.join(SANDBOX, 'repo', '.env');
  configDir = path.join(SANDBOX, 'home', '.config', 'slack-self-mcp');
});

afterEach(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('leaves env untouched when no files exist', () => {
    const env = {};
    assert.deepEqual(loadConfig({ env, envFile, configDir }), {});
    assert.deepEqual(env, {});
  });

  it('process env wins over .env and token files', () => {
    write(envFile, 'SLACK_USER_TOKEN=xoxp-dotenv\n');
    write(path.join(configDir, 'user-token'), 'xoxp-file\n');
    const env = { SLACK_USER_TOKEN: 'xoxp-env' };
    const sources = loadConfig({ env, envFile, configDir });
    assert.equal(env.SLACK_USER_TOKEN, 'xoxp-env');
    assert.equal(sources.SLACK_USER_TOKEN, 'env');
  });

  it('.env wins over token files', () => {
    write(envFile, 'SLACK_USER_TOKEN=xoxp-dotenv\nSLACK_APP_TOKEN="xapp-dotenv"\n');
    write(path.join(configDir, 'user-token'), 'xoxp-file');
    write(path.join(configDir, 'app-token'), 'xapp-file');
    const env = {};
    const sources = loadConfig({ env, envFile, configDir });
    assert.equal(env.SLACK_USER_TOKEN, 'xoxp-dotenv');
    assert.equal(env.SLACK_APP_TOKEN, 'xapp-dotenv');
    assert.equal(sources.SLACK_USER_TOKEN, envFile);
  });

  it('reads trimmed tokens from ~/.config/slack-self-mcp/', () => {
    write(path.join(configDir, 'user-token'), '  xoxp-file\n');
    write(path.join(configDir, 'app-token'), 'xapp-file\n');
    const env = {};
    const sources = loadConfig({ env, envFile, configDir });
    assert.equal(env.SLACK_USER_TOKEN, 'xoxp-file');
    assert.equal(env.SLACK_APP_TOKEN, 'xapp-file');
    assert.equal(sources.SLACK_APP_TOKEN, path.join(configDir, 'app-token'));
  });

  it('*_FILE env vars point at a different token file', () => {
    const custom = path.join(SANDBOX, 'elsewhere', 'tok');
    write(custom, 'xoxp-custom\n');
    write(path.join(configDir, 'user-token'), 'xoxp-default\n');
    const env = { SLACK_USER_TOKEN_FILE: custom };
    loadConfig({ env, envFile, configDir });
    assert.equal(env.SLACK_USER_TOKEN, 'xoxp-custom');
    assert.equal(tokenFilePath('SLACK_USER_TOKEN', { env, configDir }), custom);
  });

  it('*_FILE set in .env is used for the token file lookup', () => {
    const custom = path.join(SANDBOX, 'elsewhere', 'app');
    write(custom, 'xapp-custom\n');
    write(envFile, `SLACK_APP_TOKEN_FILE=${custom}\n`);
    const env = {};
    loadConfig({ env, envFile, configDir });
    assert.equal(env.SLACK_APP_TOKEN, 'xapp-custom');
  });

  it('an empty token in env counts as unset', () => {
    write(path.join(configDir, 'user-token'), 'xoxp-file\n');
    const env = { SLACK_USER_TOKEN: '' };
    loadConfig({ env, envFile, configDir });
    assert.equal(env.SLACK_USER_TOKEN, 'xoxp-file');
  });

  it('an empty token in .env does not hide the token file', () => {
    write(envFile, 'SLACK_USER_TOKEN=\n');
    write(path.join(configDir, 'user-token'), 'xoxp-file\n');
    const env = {};
    loadConfig({ env, envFile, configDir });
    assert.equal(env.SLACK_USER_TOKEN, 'xoxp-file');
  });

  it('an empty token file counts as missing', () => {
    write(path.join(configDir, 'user-token'), '\n');
    const env = {};
    assert.deepEqual(loadConfig({ env, envFile, configDir }), {});
    assert.equal(env.SLACK_USER_TOKEN, undefined);
  });

  it('loads non-token settings from .env without overriding env, even when empty', () => {
    write(envFile, 'SLACK_SEND_FOOTER=_from dotenv_\nSLACK_LISTEN_INCLUDE_SUBTYPES=1\n');
    const env = { SLACK_SEND_FOOTER: '' };
    loadConfig({ env, envFile, configDir });
    assert.equal(env.SLACK_SEND_FOOTER, '');
    assert.equal(env.SLACK_LISTEN_INCLUDE_SUBTYPES, '1');
  });

  it('throws when .env exists but cannot be read', () => {
    fs.mkdirSync(envFile, { recursive: true });
    assert.throws(() => loadConfig({ env: {}, envFile, configDir }), { code: 'EISDIR' });
  });
});

describe('missingTokenHelp', () => {
  it('names all three places a token can go', () => {
    const msg = missingTokenHelp('SLACK_APP_TOKEN', { env: {}, envFile, configDir });
    assert.match(msg, /SLACK_APP_TOKEN in the MCP server env/);
    assert.ok(msg.includes(envFile));
    assert.ok(msg.includes(path.join(configDir, 'app-token')));
  });
});
