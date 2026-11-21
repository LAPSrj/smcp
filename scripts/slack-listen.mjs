#!/usr/bin/env node
// Singleton Slack Socket Mode listener. One daemon per machine + user
// token. Owns the Socket Mode connection; writes shaped+enriched events
// to events.jsonl for per-agent stream binaries (scripts/slack-listen-stream.mjs)
// to tail and filter.
//
// Lifecycle: this process is normally spawned detached by src/listener-singleton.mjs
// (called from src/server.mjs at MCP boot, or from the stream binary at
// Monitor boot). At startup it claims listener.pid + listener.heartbeat;
// from then on it touches the heartbeat every HEARTBEAT_TICK_MS so peers
// can tell it's alive. On SIGTERM/SIGINT it cleans up its files.
//
// Output channels:
//   events.jsonl  — append-only event stream (one JSON line per shaped event,
//                   plus synthetic {"event":"slack_connected"/"slack_disconnected"}
//                   lines so consumers can detect gaps).
//   listener.log  — stderr (diagnostics, boot, errors). Rotated by external
//                   tooling; we just append.
//
// Env:
//   SLACK_USER_TOKEN  — xoxp-… for user/channel name resolution + auth.test
//   SLACK_APP_TOKEN   — xapp-… for the socket connection
//   SLACK_BOT_TOKEN   — optional xoxb-…, only to recognize the bot's own posts
//
// Tokens are read from process.env, the repo .env, ~/.config/slack-mcp/,
// then from $XDG_RUNTIME_DIR/.../tokens.env as a fallback (Monitor strips env
// when spawning children).

import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import fs from 'node:fs';

import { loadConfig, missingTokenHelp } from '../src/config.mjs';
import { runtimeTokensPath, readTokens } from '../src/runtime-tokens.mjs';
import {
  DEFAULT_TTL_MS,
  readRecentSends,
  matchesRecentSend,
} from '../src/recent-sends.mjs';
import {
  HEARTBEAT_TICK_MS,
  eventsPath,
  eventsRotatedPath,
  writeHeartbeat,
  writePidFile,
  clearSingletonFiles,
} from '../src/listener-singleton.mjs';
import { answeredBlocks, formValues, hasButtons, isMultiple, multipleReplyBlocks, visibleTo } from '../src/controls.mjs';
import { findEphemeralForm } from '../src/ephemeral-forms.mjs';

const EVENTS_ROTATE_BYTES = 5 * 1024 * 1024; // 5 MB
const ECHO_RECHECK_MS = 6000;

for (const [key, source] of Object.entries(loadConfig())) {
  if (source !== 'env') console.error(`slack-listen: ${key} loaded from ${source}`);
}

let USER_TOKEN = process.env.SLACK_USER_TOKEN;
let APP_TOKEN = process.env.SLACK_APP_TOKEN;
let BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const INCLUDE_SUBTYPES_DEFAULT = process.env.SLACK_LISTEN_INCLUDE_SUBTYPES === '1';

if (!USER_TOKEN || !APP_TOKEN || !BOT_TOKEN) {
  try {
    const fileTokens = readTokens();
    if (fileTokens) {
      if (!USER_TOKEN && fileTokens.SLACK_USER_TOKEN) USER_TOKEN = fileTokens.SLACK_USER_TOKEN;
      if (!APP_TOKEN && fileTokens.SLACK_APP_TOKEN) APP_TOKEN = fileTokens.SLACK_APP_TOKEN;
      if (!BOT_TOKEN && fileTokens.SLACK_BOT_TOKEN) BOT_TOKEN = fileTokens.SLACK_BOT_TOKEN;
      if (USER_TOKEN || APP_TOKEN) {
        console.error(`slack-listen: loaded tokens from runtime file ${runtimeTokensPath()}`);
      }
    }
  } catch (err) {
    console.error(`slack-listen: could not read runtime tokens file ${runtimeTokensPath()}: ${err.message}`);
  }
}

function diagnoseMissingToken(name) {
  return [
    `slack-listen: ${name} is not set in env, the repo .env, its token file, or the runtime tokens file (${runtimeTokensPath()}).`,
    `To fix: ${missingTokenHelp(name)}`,
  ].join(' ');
}

if (!USER_TOKEN) {
  console.error(diagnoseMissingToken('SLACK_USER_TOKEN'));
  process.exit(1);
}
if (!APP_TOKEN) {
  console.error(diagnoseMissingToken('SLACK_APP_TOKEN'));
  process.exit(1);
}
if (!APP_TOKEN.startsWith('xapp-')) {
  console.error(`slack-listen: SLACK_APP_TOKEN does not start with "xapp-". Got prefix: ${APP_TOKEN.slice(0, 5)}…`);
  process.exit(1);
}

const web = new WebClient(USER_TOKEN);
const socket = new SocketModeClient({ appToken: APP_TOKEN });

const userCache = new Map();   // user_id → { name, real_name }
const channelCache = new Map(); // channel_id → { name, is_im, is_mpim, is_private }

let selfUserId = null;
let botUserId = null;
let botId = null;
let heartbeatTimer = null;

// Posts from the bot count as ours, the same as posts from the user.
function isOwnAuthor(event) {
  if (event.user && (event.user === selfUserId || event.user === botUserId)) return true;
  return !!botId && event.bot_id === botId;
}

// With both user and bot event subscriptions, a message in a conversation
// both are in can arrive twice. Set keeps insertion order, so the oldest key
// is dropped first.
const SEEN_MAX = 1000;
const seenEvents = new Set();
function isRepeatDelivery(event) {
  const key = `${event.channel}:${event.ts}:${event.subtype ?? ''}`;
  if (seenEvents.has(key)) return true;
  seenEvents.add(key);
  if (seenEvents.size > SEEN_MAX) seenEvents.delete(seenEvents.values().next().value);
  return false;
}

async function lookupUser(userId) {
  if (!userId) return null;
  if (userCache.has(userId)) return userCache.get(userId);
  try {
    const res = await web.users.info({ user: userId });
    const entry = {
      name: res.user?.name ?? null,
      real_name: res.user?.real_name ?? res.user?.profile?.real_name ?? null,
    };
    userCache.set(userId, entry);
    return entry;
  } catch (err) {
    console.error(`slack-listen: users.info(${userId}) failed: ${err.data?.error || err.message}`);
    userCache.set(userId, { name: null, real_name: null });
    return userCache.get(userId);
  }
}

async function lookupChannel(channelId) {
  if (!channelId) return null;
  if (channelCache.has(channelId)) return channelCache.get(channelId);
  try {
    let res;
    try {
      res = await web.conversations.info({ channel: channelId });
    } catch (err) {
      // The user token can't see conversations only the bot is in, such as people's DMs with the bot.
      if (!BOT_TOKEN || err.data?.error !== 'channel_not_found') throw err;
      res = await new WebClient(BOT_TOKEN).conversations.info({ channel: channelId });
    }
    const c = res.channel;
    const entry = {
      name: c?.name ?? null,
      is_im: !!c?.is_im,
      is_mpim: !!c?.is_mpim,
      is_private: !!c?.is_private,
    };
    channelCache.set(channelId, entry);
    return entry;
  } catch (err) {
    console.error(`slack-listen: conversations.info(${channelId}) failed: ${err.data?.error || err.message}`);
    channelCache.set(channelId, { name: null, is_im: false, is_mpim: false, is_private: false });
    return channelCache.get(channelId);
  }
}

// Maybe rotate events.jsonl when it crosses EVENTS_ROTATE_BYTES. Two-segment
// scheme: events.jsonl → events.1.jsonl (overwriting any existing .1), then
// open a fresh events.jsonl on the next append. Rename is atomic on POSIX,
// so any tailer with a live fd on the old inode drains cleanly.
function maybeRotateEvents() {
  try {
    const st = fs.statSync(eventsPath());
    if (st.size < EVENTS_ROTATE_BYTES) return;
    fs.renameSync(eventsPath(), eventsRotatedPath());
    console.error(`slack-listen: rotated events.jsonl → events.1.jsonl at ${st.size} bytes`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`slack-listen: rotate check failed: ${err.message}`);
    }
  }
}

function emitEvent(obj) {
  try {
    maybeRotateEvents();
    fs.appendFileSync(eventsPath(), JSON.stringify(obj) + '\n', { mode: 0o600 });
    return true;
  } catch (err) {
    console.error(`slack-listen: emit failed: ${err.message}`);
    return false;
  }
}

function emitSynthetic(eventName, extra = {}) {
  emitEvent({ event: eventName, at: Date.now(), ...extra });
}

// Returns true when this event is an echo of one of OUR own outbound posts
// (chat.postMessage / files.uploadV2 / chat.update from any MCP server on
// this machine). Reads the shared recent-sends.jsonl and matches on
// (channel, ts). Best-effort — empty/missing file → returns false.
function isOwnSendEcho(event) {
  if (!event.channel || !event.ts) return false;
  const recent = readRecentSends({ ttlMs: DEFAULT_TTL_MS });
  return matchesRecentSend(recent, { channel: event.channel, ts: event.ts });
}

function channelLabel(channel, channelId) {
  if (channel?.is_im) return '(dm)';
  if (channel?.is_mpim) return '(mpim)';
  if (channel?.name) return `#${channel.name}`;
  return channelId;
}

async function shape(event) {
  const [user, channel] = await Promise.all([lookupUser(event.user), lookupChannel(event.channel)]);
  const channel_label = channelLabel(channel, event.channel);

  const files = Array.isArray(event.files)
    ? event.files.map((f) => ({
        id: f.id ?? null,
        name: f.name ?? null,
        mimetype: f.mimetype ?? null,
        url: f.url_private ?? f.permalink ?? null,
      }))
    : [];

  return {
    ts: event.ts ?? null,
    channel: event.channel ?? null,
    channel_name: channel_label,
    user: event.user ?? null,
    user_name: user?.name ?? null,
    user_real_name: user?.real_name ?? null,
    is_self: isOwnAuthor(event),
    text: event.text ?? '',
    thread_ts: event.thread_ts ?? null,
    subtype: event.subtype ?? null,
    bot_id: event.bot_id ?? null,
    files,
  };
}

// A button click on one of this app's messages. It takes the message's channel
// and ts, so the stream's channel and thread filters apply to it as they do to
// a reply. Other block actions (a select changing inside a form) don't fire,
// because form fields are input blocks without dispatch_action.
async function shapeClick(body) {
  const action = body.actions?.[0];
  if (action?.type !== 'button') return null;
  const channelId = body.container?.channel_id ?? body.channel?.id ?? null;
  const userId = body.user?.id ?? null;
  const [user, channel] = await Promise.all([lookupUser(userId), lookupChannel(channelId)]);
  const label = action.text?.text ?? action.action_id;
  return {
    kind: 'button_click',
    ts: body.container?.message_ts ?? body.message?.ts ?? null,
    channel: channelId,
    channel_name: channelLabel(channel, channelId),
    user: userId,
    user_name: user?.name ?? null,
    user_real_name: user?.real_name ?? null,
    is_self: userId === selfUserId,
    text: `clicked "${label}"`,
    thread_ts: body.message?.thread_ts ?? null,
    subtype: null,
    bot_id: null,
    files: [],
    action_id: action.action_id ?? null,
    value: action.value ?? null,
    form: formValues(body.state?.values),
  };
}

function personName(user, id) {
  return user?.real_name || user?.name || id;
}

// Replaces the form with the answers through the click's response_url. It runs
// only after the click is in events.jsonl, so a changed message tells the
// person their answer was saved, and an unchanged one that it wasn't.
async function confirmClick(body, event) {
  const message = body.message ?? (body.container?.is_ephemeral ? findEphemeralForm(event.ts) : null);
  if (!body.response_url || !hasButtons(message?.blocks)) return;
  const replier = personName({ real_name: event.user_real_name, name: event.user_name }, event.user);
  if (isMultiple(message.blocks)) {
    const visible = await remainingRepliers(message.blocks, event);
    return replaceMessage(body.response_url, event, message.text, multipleReplyBlocks(message.blocks, { replier, visible }));
  }
  const channel = await lookupChannel(event.channel);
  const names = {};
  for (const b of message.blocks) {
    if (b.type !== 'input') continue;
    const id = b.element?.action_id;
    const v = event.form[id];
    if (!v) continue;
    // A name with "@" in front can become a mention and notify that person.
    if (b.element.type === 'users_select') names[v] = personName(await lookupUser(v), v);
    if (b.element.type === 'conversations_select') names[v] = channelLabel(await lookupChannel(v), v);
  }
  const clicked = body.actions?.[0]?.text?.text ?? event.action_id;
  const repliedBy = channel?.is_im ? null : replier;
  return replaceMessage(body.response_url, event, message.text, answeredBlocks(message.blocks, { values: event.form, clicked, repliedBy, names }));
}

// Who can still reply: the IDs the buttons already show to, or on the first
// reply the conversation's members (without the bot, which can't click),
// minus the person who clicked. null when the members can't be listed.
async function remainingRepliers(blocks, event) {
  let ids = visibleTo(blocks);
  if (!ids) {
    try {
      ids = await conversationMembers(web, event.channel);
    } catch (err) {
      if (!BOT_TOKEN) return null;
      try {
        ids = await conversationMembers(new WebClient(BOT_TOKEN), event.channel);
      } catch (botErr) {
        console.error(`slack-listen: can't list members of ${event.channel}, so the buttons stay visible to everyone: ${botErr.data?.error || botErr.message}`);
        return null;
      }
    }
    ids = ids.filter((id) => id !== botUserId);
  }
  return ids.filter((id) => id !== event.user);
}

async function conversationMembers(client, channel) {
  const ids = [];
  let cursor;
  do {
    const res = await client.conversations.members({ channel, limit: 1000, cursor });
    ids.push(...(res.members ?? []));
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return ids;
}

async function replaceMessage(responseUrl, event, text, blocks) {
  const res = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ replace_original: true, text: text ?? '', blocks }),
  });
  const reply = await res.text();
  let accepted = reply.trim() === 'ok';
  try { accepted ||= JSON.parse(reply).ok === true; } catch { /* plain-text error */ }
  if (!res.ok || !accepted) {
    console.error(`slack-listen: could not update the clicked message ${event.channel}/${event.ts}: HTTP ${res.status} ${reply.slice(0, 200)}`);
  }
}

// Per-event drop decisions — only the structural ones. Per-agent filters
// (watch-self / channel / thread / include-subtypes) happen downstream
// in the stream binary; the singleton emits everything that's not a
// definite self-echo of our own send.
async function shouldDrop(event) {
  if (!event) return true;
  if (event.type !== 'message') return true;
  if (isRepeatDelivery(event)) return true;
  // Drop our own slack_send echoes; all other events flow to events.jsonl
  // so per-agent stream binaries can decide.
  if (!isOwnAuthor(event)) return false;
  if (isOwnSendEcho(event)) return true;
  // slack_send records a file post only after finding its ts in history,
  // which can finish after the event arrives, so check once more later.
  await new Promise((r) => setTimeout(r, ECHO_RECHECK_MS));
  return isOwnSendEcho(event);
}

// @slack/socket-mode v2.x: the 'slack_event' handler receives the envelope
// type at the top level (`type`), while `body` is the payload (`event_callback`
// for events_api envelopes — so `body.type === "event_callback"`, never
// `"events_api"`). Gate on `type`, then unwrap `body.event`.
socket.on('slack_event', async ({ ack, type, body }) => {
  try {
    await ack();
  } catch (err) {
    console.error(`slack-listen: ack failed: ${err.message}`);
  }
  if (type === 'interactive' && body?.type === 'block_actions') {
    try {
      const out = await shapeClick(body);
      if (out && emitEvent(out)) await confirmClick(body, out);
    } catch (err) {
      console.error(`slack-listen: click shape failed: ${err.message}`);
    }
    return;
  }
  if (type !== 'events_api') return;
  const event = body?.event;
  if (!event) return;
  if (await shouldDrop(event)) return;
  try {
    const out = await shape(event);
    emitEvent(out);
  } catch (err) {
    console.error(`slack-listen: shape failed: ${err.message}`);
  }
});

socket.on('connected', () => {
  console.error('slack-listen: connected');
  emitSynthetic('slack_connected');
});
socket.on('disconnected', (err) => {
  console.error(`slack-listen: disconnected${err ? `: ${err.message ?? err}` : ''}`);
  emitSynthetic('slack_disconnected', { error: err ? (err.message ?? String(err)) : null });
});
socket.on('unable_to_socket_mode_start', (err) => {
  console.error(`slack-listen: unable_to_socket_mode_start: ${err?.message ?? err}`);
});
socket.on('error', (err) => {
  console.error(`slack-listen: error: ${err?.message ?? err}`);
});

function startHeartbeat() {
  writeHeartbeat();
  heartbeatTimer = setInterval(() => {
    try { writeHeartbeat(); } catch (err) {
      console.error(`slack-listen: heartbeat failed: ${err.message}`);
    }
  }, HEARTBEAT_TICK_MS);
  heartbeatTimer.unref();
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function main() {
  writePidFile();
  startHeartbeat();
  const auth = await web.auth.test();
  selfUserId = auth.user_id;
  console.error(`slack-listen: auth.test ok, user=${auth.user} (${selfUserId}), team=${auth.team}`);
  if (BOT_TOKEN) {
    try {
      const botAuth = await new WebClient(BOT_TOKEN).auth.test();
      botUserId = botAuth.user_id;
      botId = botAuth.bot_id;
      console.error(`slack-listen: bot auth.test ok, bot=${botAuth.user} (${botUserId}, ${botId})`);
    } catch (err) {
      console.error(`slack-listen: bot auth.test failed, bot posts will look like other people's: ${err.data?.error || err.message}`);
    }
  }
  console.error(`slack-listen: include_subtypes default=${INCLUDE_SUBTYPES_DEFAULT} (per-agent filter, set on the stream binary)`);
  await socket.start();
}

function shutdown(signal) {
  console.error(`slack-listen: ${signal} received, shutting down`);
  stopHeartbeat();
  socket
    .disconnect()
    .catch((err) => console.error(`slack-listen: disconnect error: ${err.message}`))
    .finally(() => {
      clearSingletonFiles();
      process.exit(0);
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

main().catch((err) => {
  console.error(`slack-listen: fatal: ${err?.data?.error || err?.message || err}`);
  stopHeartbeat();
  clearSingletonFiles();
  process.exit(1);
});
