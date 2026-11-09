// Moves the token holder's read position forward, never backward.

export const TS_PATTERN = /^\d+(\.\d+)?$/;

// Slack ts values have more digits than a double holds exactly, so compare as integers.
function tsKey(ts) {
  const [secs, frac = ''] = String(ts).split('.');
  return BigInt(secs) * 1000000n + BigInt(frac.padEnd(6, '0').slice(0, 6));
}

export function compareTs(a, b) {
  const ka = tsKey(a);
  const kb = tsKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export async function markRead(slack, { channel, ts, thread_ts }) {
  const inThread = Boolean(thread_ts) && thread_ts !== ts;
  const scope = inThread ? 'thread' : 'channel';

  let lastRead;
  if (inThread) {
    const res = await slack.conversations.replies({ channel, ts: thread_ts, limit: 1 });
    lastRead = res.messages?.[0]?.last_read;
  } else {
    const res = await slack.conversations.info({ channel });
    lastRead = res.channel?.last_read;
  }

  if (!lastRead) return { marked: false, scope, reason: 'last_read_unknown', last_read: null };
  if (compareTs(ts, lastRead) <= 0) return { marked: false, scope, reason: 'already_read', last_read: lastRead };

  if (inThread) {
    // Undocumented Slack method (the one the Slack client uses); works with the existing history scopes.
    await slack.apiCall('subscriptions.thread.mark', { channel, thread_ts, ts, read: 1 });
  } else {
    await slack.conversations.mark({ channel, ts });
  }
  return { marked: true, scope, previous_last_read: lastRead, last_read: ts };
}
