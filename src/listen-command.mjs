// Builds the Monitor() spec for the per-agent stream binary.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STREAM_BINARY_PATH = path.join(PACKAGE_ROOT, 'scripts', 'slack-listen-stream.mjs');

export function buildMonitor({ watch_self, include_subtypes, channel, thread } = {}) {
  const cliArgs = [];
  if (watch_self) cliArgs.push('--watch-self');
  if (include_subtypes) cliArgs.push('--include-subtypes');
  if (channel) cliArgs.push('--channel', channel);
  if (thread) cliArgs.push('--thread', thread);
  return {
    command: `node ${STREAM_BINARY_PATH}${cliArgs.length ? ' ' + cliArgs.join(' ') : ''}`,
    description: 'Slack',
    persistent: true,
    timeout_ms: 3600000,
  };
}

// Filters on channel only: --thread would drop top-level replies, and replies
// in DMs are usually top-level.
export function replyWatch(channelId) {
  return {
    hint:
      `If you expect a reply to this message, start this Monitor now, unless a Monitor you already run covers channel ${channelId}. ` +
      'It delivers both top-level messages and thread replies in this conversation, so in a busy channel it also delivers unrelated messages.',
    monitor: buildMonitor({ channel: channelId }),
  };
}
