// Fills process.env from on-disk config before anything reads it.
// Precedence: the process env, then the repo-root .env, then the per-token
// files under ~/.config/slack-self-mcp/ (paths overridable with *_FILE).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ENV_PATH = path.join(PACKAGE_ROOT, '.env');
export const CONFIG_DIR = path.join(os.homedir(), '.config', 'slack-self-mcp');

const TOKEN_FILES = {
  SLACK_USER_TOKEN: { fileVar: 'SLACK_USER_TOKEN_FILE', name: 'user-token' },
  SLACK_APP_TOKEN: { fileVar: 'SLACK_APP_TOKEN_FILE', name: 'app-token' },
  SLACK_BOT_TOKEN: { fileVar: 'SLACK_BOT_TOKEN_FILE', name: 'bot-token' },
};

export function tokenFilePath(key, { env = process.env, configDir = CONFIG_DIR } = {}) {
  const { fileVar, name } = TOKEN_FILES[key];
  return env[fileVar] || path.join(configDir, name);
}

function readOptional(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

// An empty token (e.g. an unresolved "${VAR}" in an MCP config) counts as
// unset. Other keys keep an explicit empty value: SLACK_SEND_FOOTER="" disables
// the footer.
function isUnset(env, key) {
  return env[key] === undefined || (key in TOKEN_FILES && env[key] === '');
}

// Returns where each token came from: 'env', or the path of the file read.
export function loadConfig({ env = process.env, envFile = REPO_ENV_PATH, configDir = CONFIG_DIR } = {}) {
  const sources = {};
  for (const key of Object.keys(TOKEN_FILES)) {
    if (!isUnset(env, key)) sources[key] = 'env';
  }

  const dotenv = readOptional(envFile);
  if (dotenv !== undefined) {
    for (const [key, value] of Object.entries(parseEnv(dotenv))) {
      if (!isUnset(env, key) || (key in TOKEN_FILES && value === '')) continue;
      env[key] = value;
      if (key in TOKEN_FILES) sources[key] = envFile;
    }
  }

  for (const key of Object.keys(TOKEN_FILES)) {
    if (!isUnset(env, key)) continue;
    const file = tokenFilePath(key, { env, configDir });
    const value = readOptional(file)?.trim();
    if (value) {
      env[key] = value;
      sources[key] = file;
    }
  }
  return sources;
}

export function missingTokenHelp(key, { env = process.env, envFile = REPO_ENV_PATH, configDir = CONFIG_DIR } = {}) {
  return `set ${key} in the MCP server env, add it to ${envFile}, or write it to ${tokenFilePath(key, { env, configDir })} (mode 0600).`;
}
