// Per-user runtime dir shared by every slack-mcp process:
// $XDG_RUNTIME_DIR/slack-mcp/, or $TMPDIR/slack-mcp-<uid>/.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// XDG_RUNTIME_DIR can name a dir that was never created (WSL without a
// systemd user session), and mkdir under root-owned /run/user fails.
function usableXdgDir(xdg) {
  if (!xdg || !path.isAbsolute(xdg)) return false;
  try {
    if (!fs.statSync(xdg).isDirectory()) return false;
    fs.accessSync(xdg, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch (_) { return false; }
}

export function runtimeDir() {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (usableXdgDir(xdg)) return path.join(xdg, 'slack-mcp');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'nouid';
  return path.join(os.tmpdir(), `slack-mcp-${uid}`);
}
