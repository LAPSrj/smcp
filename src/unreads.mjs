// Conversations with messages newer than the user's read position.
// Slack reports unread counts only for DMs, and calling conversations.info on
// every conversation (hundreds of closed group DMs) runs into rate limits, so a
// search for recent messages picks the conversations worth checking.

import { compareTs } from './mark-read.mjs';
import { conversationDisplay, channelType, threadTsFromPermalink } from './messages.mjs';

export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 30;
const MAX_SEARCH_PAGES = 20;
const CONCURRENCY = 8;
const TEXT_PREVIEW = 200;

async function memberConversations(client, includeMuted) {
  const out = new Map();
  let cursor;
  do {
    const res = await client.users.conversations({
      types: 'public_channel,private_channel,mpim,im',
      exclude_archived: true,
      exclude_muted: !includeMuted,
      limit: 999,
      cursor,
    });
    for (const c of res.channels ?? []) out.set(c.id, c);
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

// Top-level messages since sinceSec, newest first, grouped by channel. Thread
// replies are left out because they don't move a channel's read position.
async function recentMessages(client, sinceSec) {
  // after: excludes the day it names, and Slack reads the date in its own
  // timezone, so search from a day earlier and cut by ts.
  const day = new Date((sinceSec - 86400) * 1000).toISOString().slice(0, 10);
  const byChannel = new Map();
  let pages = 1;
  for (let page = 1; page <= pages; page += 1) {
    if (page > MAX_SEARCH_PAGES) return { byChannel, complete: false };
    const res = await client.search.messages({ query: `after:${day}`, sort: 'timestamp', sort_dir: 'desc', count: 100, page });
    pages = res.messages?.paging?.pages ?? 0;
    let reachedStart = false;
    for (const m of res.messages?.matches ?? []) {
      if (Number(m.ts) < sinceSec) {
        reachedStart = true;
        continue;
      }
      const thread = threadTsFromPermalink(m.permalink);
      const id = m.channel?.id;
      if (!id || (thread && thread !== m.ts)) continue;
      if (!byChannel.has(id)) byChannel.set(id, []);
      byChannel.get(id).push(m);
    }
    if (reachedStart) break;
  }
  return { byChannel, complete: true };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function findUnreads(client, { selfId, lookupName, days = DEFAULT_DAYS, includeMuted = false, now = Date.now() }) {
  const sinceSec = Math.floor(now / 1000) - days * 86400;
  const [members, { byChannel, complete }] = await Promise.all([
    memberConversations(client, includeMuted),
    recentMessages(client, sinceSec),
  ]);
  const candidates = [...byChannel.keys()].filter((id) => members.has(id));
  const failed = [];
  const found = await mapLimit(candidates, CONCURRENCY, async (id) => {
    let info;
    try {
      ({ channel: info = {} } = await client.conversations.info({ channel: id }));
    } catch (err) {
      failed.push({ channel_id: id, error: err.data?.error ?? err.message });
      return null;
    }
    const c = { ...members.get(id), ...info };
    const unread = byChannel
      .get(id)
      .filter((m) => m.user !== selfId && (!c.last_read || compareTs(m.ts, c.last_read) > 0));
    if (unread.length === 0) return null;
    const newest = unread[0];
    const text = newest.text ?? '';
    return {
      channel_id: id,
      display: await conversationDisplay(c, lookupName),
      type: channelType(c),
      unread_count: unread.length,
      mentions: unread.filter((m) => m.text?.includes(`<@${selfId}>`)).length,
      last_read: c.last_read ?? null,
      newest: {
        ts: newest.ts,
        user: newest.user ?? null,
        user_name: newest.username ?? null,
        text: text.length > TEXT_PREVIEW ? `${text.slice(0, TEXT_PREVIEW)}…` : text,
        permalink: newest.permalink ?? null,
      },
    };
  });
  return {
    since: new Date(sinceSec * 1000).toISOString(),
    complete,
    checked: candidates.length,
    conversations: found.filter(Boolean).sort((a, b) => compareTs(b.newest.ts, a.newest.ts)),
    ...(failed.length > 0 && { failed }),
  };
}
