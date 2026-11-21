#!/usr/bin/env node
// MCP server exposing the slack_* tools (see TOOLS) over stdio.
// Reads with the user OAuth token (xoxp-…). Sends and edits go through the
// optional bot token (xoxb-…) when it can post there, otherwise as the user.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebClient } from '@slack/web-api';

import { loadConfig, missingTokenHelp } from './config.mjs';
import { resolveSendTarget, resolveUserId, searchTargets, lookupUserName } from './resolver.mjs';
import { buildPermalink, conversationDisplay, listScheduled, parsePostAt, searchSlack, setOwnStatus, userInfo, SEARCH_MAX_LIMIT } from './messages.mjs';
import { findUnreads, DEFAULT_DAYS, MAX_DAYS } from './unreads.mjs';
import { refusal, verifyAuthorization } from './auth-guard.mjs';
import { buildControls } from './controls.mjs';
import { recordEphemeralForm } from './ephemeral-forms.mjs';
import { messageBlocks } from './mrkdwn.mjs';
import { runtimeTokensPath, writeTokens } from './runtime-tokens.mjs';
import { recordSend, recentSendsPath, DEFAULT_TTL_MS } from './recent-sends.mjs';
import { STREAM_BINARY_PATH, buildMonitor, replyWatch } from './listen-command.mjs';
import { TS_PATTERN, markRead } from './mark-read.mjs';
import {
  ensureRunning as ensureSingleton,
  singletonAlive,
  singletonPid,
  heartbeatAgeMs,
  eventsPath,
  listenerLogPath,
} from './listener-singleton.mjs';

for (const [key, source] of Object.entries(loadConfig())) {
  if (source !== 'env') console.error(`slack-mcp: ${key} loaded from ${source}`);
}

const USER_TOKEN = process.env.SLACK_USER_TOKEN;
if (!USER_TOKEN) {
  console.error(
    `slack-mcp: no SLACK_USER_TOKEN (xoxp-… user OAuth token) found: ${missingTokenHelp('SLACK_USER_TOKEN')} See README.`,
  );
  process.exit(1);
}
if (!USER_TOKEN.startsWith('xoxp-')) {
  console.error(
    `slack-mcp: SLACK_USER_TOKEN does not start with "xoxp-". This MCP requires a user OAuth token so messages are sent as the human user. Got prefix: ${USER_TOKEN.slice(0, 5)}…`,
  );
  process.exit(1);
}

const slack = new WebClient(USER_TOKEN);

let workspaceUrlCache = null;
async function workspaceUrl() {
  workspaceUrlCache ??= (await slack.auth.test()).url;
  return workspaceUrlCache;
}

let selfIdCache = null;
async function selfUserId() {
  selfIdCache ??= (await slack.auth.test()).user_id;
  return selfIdCache;
}

// Optional bot token: sends and edits try it first and fall back to the user.
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
let bot = null;
if (BOT_TOKEN.startsWith('xoxb-')) {
  bot = new WebClient(BOT_TOKEN);
} else if (BOT_TOKEN) {
  console.error(
    `slack-mcp: SLACK_BOT_TOKEN does not start with "xoxb-", so every message is sent as the user. Got prefix: ${BOT_TOKEN.slice(0, 5)}…`,
  );
}
// "@me" is the DM where agents reach the user: the one with the bot, which
// notifies them, or their self-DM without a bot. In a group-DM list it is
// the user, whom the resolver drops because Slack adds them anyway.
const isMe = (t) => typeof t === 'string' && t.trim().toLowerCase() === '@me';
let botUserIdCache = null;
async function botUserId() {
  botUserIdCache ??= (await bot.auth.test()).user_id;
  return botUserIdCache;
}

let meIds = null;
async function expandMe(target) {
  const list = Array.isArray(target) ? target : [target];
  if (!list.some(isMe)) return target;
  if (!meIds) {
    const self = (await slack.auth.test()).user_id;
    let dm = self;
    if (bot) {
      try {
        dm = await botUserId();
      } catch (err) {
        console.error(`slack-mcp: bot auth.test failed, @me falls back to the self-DM: ${formatSlackError(err)}`);
      }
    }
    meIds = { self, dm };
  }
  if (list.length === 1) return meIds.dm;
  return list.map((t) => (isMe(t) ? meIds.self : t));
}

// Conversations only the bot is in (people's DMs with it) are invisible to
// the user token, so a channel ID the user can't resolve is tried as the bot.
// Returns the resolution and the client that can read that conversation.
async function resolveConversation(target) {
  const expanded = await expandMe(target);
  const resolution = await resolveSendTarget(slack, expanded);
  const id = typeof expanded === 'string' ? expanded.trim() : '';
  if (!resolution.error || !bot || !/^[CGD][A-Z0-9]{6,}$/.test(id)) return { resolution, reader: slack };
  try {
    const { channel: c } = await bot.conversations.info({ channel: id });
    const type = c.is_im ? 'im' : c.is_mpim ? 'mpim' : c.is_private ? 'private_channel' : 'public_channel';
    let display = c.name ? `#${c.name}` : c.id;
    if (c.is_im && c.user) display = `bot DM with @${(await lookupUserName(slack, c.user))?.name ?? c.user}`;
    return { resolution: { channel_id: c.id, type, display, bot_only: true }, reader: bot };
  } catch {
    return { resolution, reader: slack };
  }
}

const BOT_IDENTITY = Object.fromEntries(
  [['username', process.env.SLACK_BOT_USERNAME], ['icon_url', process.env.SLACK_BOT_ICON_URL]].filter(([, v]) => v),
);

// Hand off tokens to the listener via $XDG_RUNTIME_DIR/slack-mcp/tokens.env
// (mode 0600, in user-private tmpfs). Monitor strips env from spawned children;
// rather than push tokens into the listener's command line — visible in
// `ps`/`/proc/*/cmdline` to other processes — the server publishes them to a
// per-user runtime file the listener reads as a fallback when its own env is
// missing.
//
// No on-exit cleanup: with multiple concurrent server instances (one per
// claude tab), unlinking on shutdown would delete a file siblings still
// depend on. XDG_RUNTIME_DIR auto-clears at user logout, which is the only
// safe cleanup boundary in a multi-process world.
function ensureRuntimeTokens() {
  try {
    return writeTokens({
      SLACK_USER_TOKEN: USER_TOKEN,
      SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN ?? '',
      SLACK_BOT_TOKEN: bot ? BOT_TOKEN : '',
    });
  } catch (err) {
    console.error(`slack-mcp: could not write runtime tokens: ${err.message}`);
    return null;
  }
}
let RUNTIME_TOKENS_PATH = ensureRuntimeTokens();
if (RUNTIME_TOKENS_PATH) {
  console.error(`slack-mcp: wrote runtime tokens to ${RUNTIME_TOKENS_PATH}`);
}

// Bring up the singleton Slack listener at server boot. Best-effort —
// errors don't fail the server boot since the MCP-side tools (send/edit/
// history/file_download/resolve) work without it. The listener daemon is
// only required for the slack_listen_instructions consumer flow.
ensureSingleton().then((result) => {
  if (result.error) {
    console.error(`slack-mcp: singleton listener ensure failed: ${result.error}`);
  } else if (result.alreadyRunning) {
    console.error(`slack-mcp: singleton listener alive (pid=${result.pid}, heartbeat_age=${result.heartbeat_age_ms}ms)`);
  } else if (result.spawned) {
    console.error(`slack-mcp: spawned singleton listener (pid=${result.pid})${result.warning ? ` warning=${result.warning}` : ''}`);
  }
}).catch((err) => {
  console.error(`slack-mcp: singleton ensure threw: ${err.message}`);
});

// Footer under messages posted as the user, so recipients can tell they came
// through automation. Default "*Sent using* <app name>"; an empty
// SLACK_SEND_FOOTER disables it.
const FOOTER = process.env.SLACK_SEND_FOOTER;

// The name Slack shows for the app's posts. bots.info needs users:read, which
// the user token has and the bot token may not.
let appNameCache = null;
function appName() {
  appNameCache ??= (async () => {
    if (!bot) return 'AI';
    try {
      return (await slack.bots.info({ bot: (await bot.auth.test()).bot_id })).bot?.name || 'AI';
    } catch (err) {
      console.error(`slack-mcp: could not read the app name for the footer: ${formatSlackError(err)}`);
      return 'AI';
    }
  })();
  return appNameCache;
}

async function footerText(signature) {
  if (FOOTER === '') return '';
  const base = FOOTER ?? `*Sent using* ${await appName()}`;
  const sig = typeof signature === 'string' ? signature.trim() : '';
  return sig ? `${base} (${sig})` : base;
}

async function userContent(text, signature, markdown, controls = []) {
  if (!text) return null;
  const footer = await footerText(signature);
  if (footer || controls.length > 0) return messageBlocks(text, { markdown, footer, controls });
  return messageContent(text, markdown);
}

const FORMAT_SCHEMA = {
  type: 'string',
  enum: ['mrkdwn', 'markdown'],
  description: '"markdown" (default): standard Markdown, **bold**, ~~strike~~, [text](url), tables and headings. "mrkdwn": Slack syntax, *bold* and ~strike~. Mentions (<@U…>, <#C…>, <!here>) and <url|text> links work in both.',
};

const TOOLS = [
  {
    name: 'slack_send',
    description:
      'Send a Slack message, optionally with file attachments. ' +
      'If a bot token is configured, it posts as the bot; where the bot cannot post (DMs between people, group DMs, private channels it is not in), ' +
      'it posts as the human user instead, with a "Sent using <app name>" footer. The result\'s posted_as says which ("bot" or "user"), and bot_error says why the bot failed. ' +
      'Set as to "bot" when the message must come from the bot (e.g. "DM X as the bot"): a person as the target then means the bot\'s own DM with them, ' +
      'and nothing is sent as the human if the bot can\'t post. as "user" always posts as the human. ' +
      'target accepts a single reference (#channel-name, channel ID C…/G…, @handle, user ID U…, email, or @me for the DM where you reach the human: ' +
      'their DM with the bot, or their self-DM when no bot token is set) ' +
      'OR an array of 2-8 user references — in which case slack-mcp opens an MPIM (group DM) for that user set ' +
      'via conversations.open and posts to the resulting channel. Slack auto-includes the caller and dedupes, ' +
      'so opening the same MPIM repeatedly returns the same channel. ' +
      'On a unique single match, posts text via chat.postMessage; if file_paths is non-empty, ' +
      'it instead uploads all files via files_upload_v2 as ONE message with text as its comment. thread_ts applies either way. ' +
      'On ambiguous/unknown target, returns { error, candidates: [...] } — re-call with target_id from a candidate. ' +
      'The result has the message permalink; give it to the human when you tell them you posted. ' +
      'Text is standard Markdown by default (**bold**, [text](url), tables, headings); set format "mrkdwn" for Slack\'s own syntax (*bold*). ' +
      'post_at schedules a text message instead of sending it now (no file_paths); it returns scheduled_message_id and no ts. ' +
      'visible_to posts an ephemeral message that only that person sees, in the target conversation; it returns message_ts and no permalink. ' +
      'buttons and form add buttons and form fields under the text. A click on any button arrives in the reply_watch Monitor as a kind "button_click" event ' +
      'with action_id, value, the clicker, and form (every field\'s value by field id), on the message\'s channel and ts. Anyone who can see the message can click, so check user. ' +
      'When the listener has saved a click, it replaces the fields with the answers and removes the buttons, so each message takes one click; ' +
      'in a group conversation it also shows "Replied by" and the person\'s name. If the message doesn\'t change, the click never reached the listener. ' +
      'To report the outcome, edit the message with slack_edit (that replaces the whole message, answers included). ' +
      'A form without buttons gets a Submit button (id "submit"). Not with file_paths. ' +
      'replies "multiple" (channels and group DMs) keeps the form open for everyone else: each person\'s buttons disappear once they reply, and a line lists who replied. ' +
      'If you expect a reply, start the Monitor in the result\'s reply_watch field right after sending; it delivers both top-level and thread replies in that conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description:
            'Single reference (#channel, channel ID, @handle, user ID, email, or @me), OR an array of user references. ' +
            'An array with 2-8 user references opens an MPIM (group DM) and posts there. ' +
            'A length-1 array is treated the same as the equivalent single string.',
        },
        text: {
          type: 'string',
          description: 'Message text. Optional if file_paths is non-empty (uploads will have no parent text).',
        },
        as: {
          type: 'string',
          enum: ['auto', 'bot', 'user'],
          description:
            'Who posts. "auto" (default): the bot where it can, else the human. "bot": only the bot, and a person as the target ' +
            'means the bot\'s DM with them (the human can\'t see that DM; replies reach the bot). "user": only the human.',
        },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths to files to attach. Posted together with text as one message (in the thread if thread_ts is set).',
        },
        thread_ts: {
          type: 'string',
          description: 'Optional parent message ts to reply within a thread.',
        },
        format: FORMAT_SCHEMA,
        reply_broadcast: {
          type: 'boolean',
          description: 'With thread_ts, also show the reply in the channel. Text messages only.',
        },
        unfurl: {
          type: 'boolean',
          description: 'true shows link and media previews, false hides them. Omit for Slack\'s default. Text messages only.',
        },
        post_at: {
          oneOf: [{ type: 'number' }, { type: 'string' }],
          description:
            'Schedule instead of sending now: Unix seconds, or an ISO 8601 time with its offset (e.g. "2026-11-19T09:00:00-08:00"). ' +
            'Slack needs it in the future and at most 120 days out. Text messages only. List pending ones with slack_scheduled and cancel one with slack_delete.',
        },
        visible_to: {
          type: 'string',
          description:
            'Post an ephemeral message only this person sees (@handle, user ID, email, or @me for the human), in the conversation target names; ' +
            'they must be a member of it. Slack shows it only while they have Slack open and drops it on reload, and it has no permalink. ' +
            'Text messages only: not with file_paths, post_at, reply_broadcast, unfurl or replies "multiple". Buttons and form work.',
        },
        buttons: {
          type: 'array',
          minItems: 1,
          maxItems: 25,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'action_id the click event reports.' },
              label: { type: 'string', description: 'Button text, at most 75 characters.' },
              style: { type: 'string', enum: ['primary', 'danger'], description: 'primary is green, danger is red; omit for a plain button.' },
              value: { type: 'string', description: 'Optional value the click event reports.' },
            },
            required: ['id', 'label'],
          },
          description: 'Buttons under the text (and under the form, if any), in one row.',
        },
        form: {
          type: 'array',
          minItems: 1,
          maxItems: 40,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Key of this field in the click event\'s form.' },
              label: { type: 'string' },
              type: {
                type: 'string',
                enum: ['text', 'multiline', 'number', 'select', 'multi_select', 'checkboxes', 'radio', 'date', 'time', 'user', 'channel'],
                description: 'Default "text". date reports YYYY-MM-DD, time HH:mm, user a user ID, channel a channel ID, multi_select and checkboxes a list.',
              },
              options: { type: 'array', items: { type: 'string' }, description: 'Choices for select, multi_select, checkboxes and radio (1-100).' },
              initial: {
                oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                description: 'Prefilled value: one of options, a list of options for multi_select and checkboxes, YYYY-MM-DD, HH:mm, a user ID or a channel ID.',
              },
              placeholder: { type: 'string', description: 'Grey hint inside the field (not for checkboxes or radio).' },
            },
            required: ['id', 'label'],
          },
          description: 'Form fields under the text. Their values arrive with the next button click. Slack lets any field be left empty (null, or [] for lists), so check the values.',
        },
        replies: {
          type: 'string',
          enum: ['single', 'multiple', 'poll'],
          description:
            '"single" (default): the first click closes the form for everyone. "multiple": each person in the conversation can reply once; ' +
            'their buttons disappear after they reply and the fields stay. "poll": buttons only, one per choice; each person picks one and can change it, ' +
            'a sortable table above the buttons lists everyone\'s pick with a count per choice, and each person sees their own pick highlighted. ' +
            '"multiple" and "poll" don\'t work with visible_to.',
        },
        poll_layout: {
          type: 'string',
          enum: ['by_person', 'by_answer'],
          description: 'With replies "poll": "by_person" (default) lists one row per person with their answer; "by_answer" has one column per choice with the names under it.',
        },
        poll_note: {
          type: 'string',
          description:
            'With replies "poll": label of an optional note field above the buttons (e.g. "Note"), up to 100 characters per note. ' +
            'Each pick saves the note typed at that moment, an empty field clears it, and the table shows it (a Note column by person, "Name (note)" by answer). ' +
            'The click event has it as form.poll_note.',
        },
        agent_signature: {
          type: 'string',
          description:
            'Optional self-identifier the calling agent can include if it wants to. ' +
            'Appears in parentheses in the footer, e.g. setting it to ' +
            '"Claude Code" produces "Sent using L.E.O (Claude Code)". Only applied to ' +
            'posts made as the human, when the footer is enabled and the message has text.',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'slack_edit',
    description:
      'Edit a previously sent message via chat.update. Each token can only edit its own messages, so it tries the bot token first and then the user token; ' +
      'edited_as in the result says which one worked. ' +
      'For threaded replies, ts is the reply\'s own ts (not the parent thread_ts). text fully replaces the previous text, and the edit also removes any buttons and form fields.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel ID returned by slack_send.' },
        ts: { type: 'string', description: 'Message ts returned by slack_send.' },
        text: { type: 'string', description: 'Replacement text.' },
        format: FORMAT_SCHEMA,
        agent_signature: {
          type: 'string',
          description:
            'Optional self-identifier the calling agent can include if it wants to. ' +
            'Appears in parentheses in the footer, e.g. "Sent using L.E.O (Claude Code)".',
        },
      },
      required: ['channel_id', 'ts', 'text'],
    },
  },
  {
    name: 'slack_history',
    description:
      'Read recent messages in a channel/DM/MPIM, or the full reply set of a thread. ' +
      'target follows the same rules as slack_send: a single reference, or an array of 2-8 user references ' +
      '(resolved to the corresponding MPIM via conversations.open — idempotent, so this does not create a new conversation if it already exists). ' +
      'Without thread_ts: conversations.history, newest first. With thread_ts: conversations.replies, oldest first (parent first). ' +
      'before_ts and after_ts bound the time range; pass the result\'s next_cursor as cursor for the next page. ' +
      'Each message has a permalink, and a thread parent has reply_count and latest_reply, so you can tell which messages have threads. ' +
      'limit defaults to 20, capped at 100 for a channel and 1000 for a thread. Subtype-bearing messages (joins, edits, file shares) are returned — caller decides what is relevant.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description:
            'Single reference (#channel, channel ID, @handle, user ID, email, or @me), OR an array of user references for an MPIM (group DM).',
        },
        limit: { type: 'number', description: 'Max messages. Default 20, capped at 100 (1000 with thread_ts).' },
        thread_ts: { type: 'string', description: 'If set, fetch the full reply set via conversations.replies.' },
        before_ts: { type: 'string', description: 'Only messages before this ts — passed to the API as "latest".' },
        after_ts: { type: 'string', description: 'Only messages after this ts — passed to the API as "oldest". Use it to read what is new since a message.' },
        cursor: { type: 'string', description: 'next_cursor from a previous result, for the next page.' },
      },
      required: ['target'],
    },
  },
  {
    name: 'slack_mark_read',
    description:
      'Mark a message as read for the human user, moving the read position forward only. ' +
      'Top-level message (no thread_ts, or thread_ts == ts): conversations.mark moves the channel read position to ts. ' +
      'Thread reply (thread_ts != ts): subscriptions.thread.mark moves the thread read position (undocumented Slack method). ' +
      'If ts is not newer than the current read position, nothing changes and the result says reason "already_read". ' +
      'If Slack reports no read position, nothing changes and the result says reason "last_read_unknown". ' +
      'Needs channels:write / groups:write / im:write / mpim:write on the user token for the channel kind; missing_scope means the app needs that scope and a reinstall.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Same as slack_history: #channel, channel ID, @handle, user ID, email, @me, or an array of user references for an MPIM.',
        },
        ts: { type: 'string', description: 'ts of the newest message to mark as read.' },
        thread_ts: { type: 'string', description: 'Parent ts when ts is a thread reply.' },
      },
      required: ['target', 'ts'],
    },
  },
  {
    name: 'slack_listen_instructions',
    description:
      'Returns the Monitor() invocation for the per-agent Slack event stream. The MCP ' +
      'architecture is: ONE singleton listener daemon per machine owns the Slack Socket ' +
      'Mode connection and writes shaped events to events.jsonl; each agent\'s Monitor ' +
      'invokes a per-agent stream binary (scripts/slack-listen-stream.mjs) that tails ' +
      'events.jsonl and applies per-agent filters. The MCP server has already ensured ' +
      'the singleton is running. Echoes of this user-token\'s own slack_send / slack_edit ' +
      'posts are deduped by the singleton before they reach events.jsonl — so you never ' +
      'see your own posts come back. Pass watch_self / channel / thread / include_subtypes ' +
      'to bake the corresponding --flags into the returned command.',
    inputSchema: {
      type: 'object',
      properties: {
        watch_self: {
          type: 'boolean',
          description:
            'Include events authored by the token-holder (the human, when typing in the Slack ' +
            'client on a channel/MPIM the Slack platform delivers events for). Default false. ' +
            'Note: self-typed DMs are platform-quirky in user-token Socket Mode and may not ' +
            'always be delivered by Slack — surface depends on channel kind and platform behavior.',
        },
        channel: {
          type: 'string',
          description: 'Filter to one channel ID (e.g. C012345 / D012345 / G012345).',
        },
        thread: {
          type: 'string',
          description:
            'Filter to one thread ts. Matches both replies (thread_ts == this ts) and the ' +
            'parent message itself (event ts == this ts).',
        },
        include_subtypes: {
          type: 'boolean',
          description:
            'Include subtype-bearing events (edits, joins, bot_message, etc.). ' +
            'Default false. File shares, thread broadcasts and /me messages from people always pass.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'slack_file_download',
    description:
      'Download a Slack file (an attachment surfaced via slack_history or the listener) to local disk. ' +
      'Pass file_id (F…, preferred — looks up url_private + filename via files.info) or url (a https://files.slack.com/… url_private, used directly). ' +
      'The GET is authenticated with the user OAuth token, or with the bot token for files only the bot can see (such as files in people\'s DMs with the bot). ' +
      'dest_path is recommended: pass an absolute file path, or an absolute directory (uses the original filename). ' +
      'If dest_path is omitted, the file lands in /tmp/<filename> — fine for an immediate Read but not durable; prefer specifying a real directory. ' +
      'Requires files:read on the user token, and on the bot token for the bot\'s files; missing_scope errors here mean the app needs reinstall.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'Slack file ID (F…). Preferred — files.info resolves url_private, name, mimetype, size.',
        },
        url: {
          type: 'string',
          description: 'Direct https://files.slack.com/… url_private. Used as-is; skip files.info. One of file_id / url is required.',
        },
        dest_path: {
          type: 'string',
          description:
            'Absolute path to write to. If it ends with "/" or names an existing directory, the original filename is appended. ' +
            'Omit to default to /tmp/<filename> (ephemeral; specify a real directory for anything you want to keep).',
        },
        overwrite: {
          type: 'boolean',
          description: 'If false (default), error when dest_path already exists. Set true to overwrite.',
        },
      },
    },
  },
  {
    name: 'slack_resolve',
    description:
      'Look up channels and people matching a target string, by name, channel topic or purpose, or job title. ' +
      'Returns { matches: [{ target_id, type, display, name?, real_name?, email?, title?, topic?, purpose?, num_members?, is_archived? }, …] }. ' +
      'With profile: true and a target that names one person, it also returns profile: title, timezone and their local time now, ' +
      'status, presence (active/away), email and phone. Here @me means the human user.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '#channel, channel ID, @handle, user ID, email, @me, a topic or title word, or bare string.' },
        profile: { type: 'boolean', description: 'Also return the profile of the one person the target names.' },
      },
      required: ['target'],
    },
  },
  {
    name: 'slack_search',
    description:
      'Search messages or files in every conversation the human user can see (public and private channels, DMs, group DMs), with their user token. ' +
      'query uses Slack search syntax: words and "exact phrases", plus modifiers such as in:#channel, in:@user, from:@user, from:<@U123>, ' +
      'with:@user, has:link, has:file, has:pin, is:thread, before:YYYY-MM-DD, after:YYYY-MM-DD, on:YYYY-MM-DD, during:month. ' +
      'Messages come back with channel_id, ts, thread_ts (for thread replies), user, text and permalink; read a whole thread with slack_history(target=channel_id, thread_ts). ' +
      'With content "files": files with id, name, permalink and the channels they were shared in; download one with slack_file_download(file_id). ' +
      'Keyword search only, so try synonyms or fewer words when nothing matches.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Slack search query, e.g. "deploy failed in:#dev-team after:2026-11-01".' },
        content: { type: 'string', enum: ['messages', 'files'], description: 'What to search. Default "messages".' },
        sort: { type: 'string', enum: ['score', 'timestamp'], description: '"score" (relevance, default) or "timestamp".' },
        sort_dir: { type: 'string', enum: ['desc', 'asc'], description: 'Default "desc" (best or newest first).' },
        limit: { type: 'number', description: `Results per page. Default 20, capped at ${SEARCH_MAX_LIMIT}.` },
        page: { type: 'number', description: 'Page number, starting at 1. The result says how many pages there are.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'slack_delete',
    description:
      'Delete a posted message, or cancel a scheduled message before Slack posts it. ' +
      'Pass channel_id with ts for a posted message, or channel_id with scheduled_message_id (from slack_send with post_at, or from slack_scheduled) for a scheduled one. ' +
      'Each token can only delete its own messages, so it tries the bot token first and then the user token; deleted_as says which one worked. ' +
      'Deleting can\'t be undone, so until the user has typed the authorization sentence in chat, the call is refused and the error gives that sentence. ' +
      'Show it to the user, and after they send it, call again with the same arguments; the server checks the conversation transcript for it. ' +
      'Slack can\'t cancel a scheduled message within 60 seconds of its post time.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel ID of the message (from slack_send, slack_history or slack_scheduled).' },
        ts: { type: 'string', description: 'ts of the posted message to delete. For a thread reply, the reply\'s own ts.' },
        scheduled_message_id: { type: 'string', description: 'ID of the scheduled message to cancel (Q…).' },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'slack_scheduled',
    description:
      'List scheduled messages Slack hasn\'t posted yet, with scheduled_message_id, channel_id, channel (its name), post_at, text and scheduled_as ("bot" or "user"). ' +
      'Slack only returns messages scheduled through this server (slack_send with post_at), not ones scheduled in the Slack app. ' +
      'Pass target to list one conversation only. Cancel one with slack_delete(channel_id, scheduled_message_id). ' +
      'Slack can\'t edit a scheduled message, so to change one, cancel it and schedule the new text with slack_send.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Optional. Same as slack_history: #channel, channel ID, @handle, user ID, email, @me, or an array of user references for an MPIM.',
        },
      },
    },
  },
  {
    name: 'slack_unreads',
    description:
      'List the conversations with messages the human user hasn\'t read (channels, DMs and group DMs they\'re in), newest first. ' +
      'Each has channel_id, display, type, unread_count, mentions (unread messages that @-mention the user), last_read, ' +
      'and the newest unread message (ts, user, user_name, text cut to 200 characters, permalink). ' +
      'Read one with slack_history(target=channel_id, after_ts=last_read) and mark it read with slack_mark_read. ' +
      `It searches messages from the last \`days\` days (default ${DEFAULT_DAYS}, at most ${MAX_DAYS}), so older unread messages, and messages Slack hasn't indexed yet (a few seconds), are missed; ` +
      'complete false means the window had more messages than one call scans, so try fewer days. ' +
      'Muted channels are skipped unless include_muted is true. Thread replies don\'t count, because they don\'t change a channel\'s read position. ' +
      'Conversations only the bot is in (people\'s DMs with the bot) aren\'t included. failed lists conversations Slack wouldn\'t describe.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: `How far back to look, in days. Default ${DEFAULT_DAYS}, at most ${MAX_DAYS}.` },
        include_muted: { type: 'boolean', description: 'Also check muted channels. Default false.' },
      },
    },
  },
  {
    name: 'slack_set_status',
    description:
      'Set the human user\'s own Slack status, presence or Do Not Disturb; pass only what should change. ' +
      'status_text and status_emoji set the status (pass "" for both to clear it), and status_expiration sets when it clears. ' +
      'presence "away" marks them away, and "auto" lets Slack decide from their activity. ' +
      'dnd_minutes pauses notifications for that many minutes, and 0 ends the pause. ' +
      'Each part needs its own user token scope (users.profile:write, users:write, dnd:write); a part that fails is listed under errors and the others still apply. ' +
      'Read the current status and presence with slack_resolve(target="@me", profile=true).',
    inputSchema: {
      type: 'object',
      properties: {
        status_text: { type: 'string', description: 'Status text, e.g. "In a meeting". "" clears it.' },
        status_emoji: { type: 'string', description: 'Emoji code, e.g. ":calendar:". "" clears it.' },
        status_expiration: {
          oneOf: [{ type: 'number' }, { type: 'string' }],
          description: 'When the status clears: Unix seconds, or ISO 8601 with its offset (e.g. "2026-11-19T17:00:00-08:00"). 0 means never.',
        },
        presence: { type: 'string', enum: ['auto', 'away'], description: '"away" or "auto".' },
        dnd_minutes: { type: 'number', description: 'Pause notifications for this many minutes; 0 ends the pause.' },
      },
    },
  },
];

const server = new Server(
  { name: 'slack-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === 'slack_send') return await handleSend(args);
    if (name === 'slack_edit') return await handleEdit(args);
    if (name === 'slack_history') return await handleHistory(args);
    if (name === 'slack_mark_read') return await handleMarkRead(args);
    if (name === 'slack_listen_instructions') return handleListenInstructions(args);
    if (name === 'slack_file_download') return await handleFileDownload(args);
    if (name === 'slack_resolve') return await handleResolve(args);
    if (name === 'slack_search') return await handleSearch(args);
    if (name === 'slack_delete') return await handleDelete(args);
    if (name === 'slack_scheduled') return await handleScheduled(args);
    if (name === 'slack_unreads') return await handleUnreads(args);
    if (name === 'slack_set_status') return await handleSetStatus(args);
    return errorResult(`unknown tool: ${name}`);
  } catch (err) {
    return errorResult(formatSlackError(err));
  }
});

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function isValidTarget(target) {
  if (typeof target === 'string') return target.length > 0;
  if (Array.isArray(target)) {
    if (target.length === 0) return false;
    return target.every((t) => typeof t === 'string' && t.length > 0);
  }
  return false;
}

function errorResult(message, extra) {
  const body = { error: message, ...(extra ?? {}) };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
}

function formatSlackError(err) {
  const apiError = err?.data?.error;
  const parts = [];
  if (err?.code) parts.push(`code=${err.code}`);
  if (apiError) parts.push(`slack_error=${apiError}`);
  if (err?.message) parts.push(err.message);
  // invalid_blocks and similar errors say which block and field Slack rejected.
  const details = err?.data?.response_metadata?.messages;
  if (Array.isArray(details) && details.length > 0) parts.push(details.join('; '));
  return parts.length ? parts.join(' | ') : String(err);
}

function checkFormat(format) {
  return format === undefined || format === 'mrkdwn' || format === 'markdown'
    ? null
    : `format must be "mrkdwn" or "markdown" (got ${JSON.stringify(format)})`;
}

async function handleSend(args) {
  const { target, text, file_paths, thread_ts, agent_signature, as = 'auto', format, reply_broadcast, unfurl, post_at, visible_to, buttons, form, replies, poll_layout, poll_note } = args;
  if (!isValidTarget(target)) {
    return errorResult('target is required (string or non-empty array of strings)');
  }
  if (!['auto', 'bot', 'user'].includes(as)) return errorResult(`as must be "auto", "bot" or "user" (got ${JSON.stringify(as)})`);
  if (as === 'bot' && !bot) return errorResult('as "bot" needs a bot token (SLACK_BOT_TOKEN), and none is set');
  const formatError = checkFormat(format);
  if (formatError) return errorResult(formatError);
  const files = Array.isArray(file_paths) ? file_paths : [];
  if (reply_broadcast && !thread_ts) return errorResult('reply_broadcast needs thread_ts');
  if (files.length > 0 && (reply_broadcast || unfurl !== undefined || post_at !== undefined)) {
    return errorResult('reply_broadcast, unfurl and post_at work on text messages only, not with file_paths');
  }
  if (visible_to !== undefined) {
    if (typeof visible_to !== 'string' || !visible_to.trim()) return errorResult('visible_to must be a person reference (@handle, user ID, email or @me)');
    if (files.length > 0 || reply_broadcast || unfurl !== undefined || post_at !== undefined || replies === 'multiple' || replies === 'poll') {
      return errorResult('visible_to (an ephemeral message) works on text messages only, not with file_paths, post_at, reply_broadcast, unfurl or replies "multiple" or "poll"');
    }
  }
  const controls = buildControls({ buttons, form, replies, pollLayout: poll_layout, pollNote: poll_note });
  if (controls.error) return errorResult(controls.error);
  if (controls.blocks.length > 0) {
    if (files.length > 0) return errorResult('buttons and form work on text messages only, not with file_paths');
    if (!text) return errorResult('buttons and form need text, which Slack shows above them and in notifications');
  }
  let postAt;
  if (post_at !== undefined) {
    postAt = parsePostAt(post_at);
    if (postAt === null) {
      return errorResult(`post_at must be Unix seconds or an ISO 8601 time with an offset, e.g. "2026-11-19T09:00:00-08:00" (got ${JSON.stringify(post_at)})`);
    }
  }
  const options = { markdown: format !== 'mrkdwn', thread_ts, reply_broadcast, unfurl, postAt };
  let viewer;
  if (visible_to !== undefined) {
    const r = await resolveUserId(slack, visible_to);
    if (r.error) return ok(r);
    options.ephemeralUser = r.user_id;
    const u = await lookupUserName(slack, r.user_id);
    viewer = { user_id: r.user_id, display: u?.name ? `@${u.name}` : r.user_id };
  }

  for (const p of files) {
    if (typeof p !== 'string' || p.length === 0) return errorResult(`file_paths entry is not a string: ${JSON.stringify(p)}`);
    if (!fs.existsSync(p)) return errorResult(`file not found: ${p}`);
    const stat = fs.statSync(p);
    if (!stat.isFile()) return errorResult(`not a regular file: ${p}`);
  }

  if ((!text || text.length === 0) && files.length === 0) {
    return errorResult('either text or file_paths must be provided');
  }

  const { resolution } = await resolveConversation(target);
  if (resolution.error) {
    return ok(resolution);
  }
  let channel_id = resolution.channel_id;
  let display = resolution.display;

  // A person as the target resolves to the user's own DM with them, which the
  // bot isn't in, so "as bot" goes to the bot's DM with that person instead.
  const dmUser = resolution.type === 'user' ? resolution.user_id ?? resolution.user_ids?.[0] : null;
  if (as === 'bot' && dmUser && dmUser !== (await botUserId())) {
    try {
      channel_id = (await bot.conversations.open({ users: dmUser })).channel.id;
      display = `bot DM with ${resolution.display}`;
    } catch (err) {
      return errorResult(`could not open the bot's DM with ${resolution.display}: ${formatSlackError(err)}`);
    }
  }

  // The bot can't post where it isn't a member (other people's DMs, group
  // DMs, private channels it wasn't invited to), so with as "auto" any bot
  // failure retries as the user. The bot's own name and APP badge replace
  // the footer.
  let sent = null;
  let bot_error;
  let content;
  if (bot && as !== 'user') {
    try {
      content = !text ? null
        : controls.blocks.length > 0 ? messageBlocks(text, { markdown: options.markdown, controls: controls.blocks })
        : messageContent(text, options.markdown);
      sent = { ...(await post(bot, { channel_id, content, files, identity: BOT_IDENTITY, ...options })), posted_as: 'bot' };
    } catch (err) {
      if (as === 'bot') return errorResult(formatSlackError(err), { channel_id, resolved_target: { type: resolution.type, display } });
      bot_error = formatSlackError(err);
    }
  }
  if (!sent) {
    content = await userContent(text, agent_signature, options.markdown, controls.blocks);
    sent = { ...(await post(slack, { channel_id, content, files, ...options })), posted_as: 'user' };
  }
  const resolved_target = { type: resolution.type, display };

  if (sent.scheduled_message_id) {
    return ok({
      channel_id,
      scheduled_message_id: sent.scheduled_message_id,
      post_at: new Date(sent.post_at * 1000).toISOString(),
      scheduled_as: sent.posted_as,
      ...(bot_error && { bot_error }),
      resolved_target,
    });
  }

  if (sent.message_ts) {
    let form_error;
    if (controls.blocks.length > 0) {
      try {
        recordEphemeralForm({ message_ts: sent.message_ts, channel: channel_id, text: content.text, blocks: content.blocks });
      } catch (err) {
        form_error = `could not save the form, so a click won't replace it: ${err.message}`;
      }
    }
    return ok({
      ...(form_error && { form_error }),
      channel_id,
      message_ts: sent.message_ts,
      visible_to: viewer,
      posted_as: sent.posted_as,
      ...(bot_error && { bot_error }),
      resolved_target,
    });
  }

  if (sent.ts) recordSend({ ts: sent.ts, channel: channel_id });

  return ok({
    channel_id,
    ts: sent.ts,
    permalink: sent.ts ? buildPermalink(await workspaceUrl(), channel_id, sent.ts, thread_ts) : null,
    file_ids: sent.file_ids,
    posted_as: sent.posted_as,
    ...(bot_error && { bot_error }),
    resolved_target,
    reply_watch: replyWatch(channel_id),
  });
}

// markdown_text can't be combined with text (Slack: markdown_text_conflict).
function messageContent(text, markdown) {
  return markdown ? { markdown_text: text } : { text };
}

// Files go as ONE message (files.uploadV2) with text as its comment, and
// uploadV2 doesn't return the share ts, so it is recovered from history.
// Slack ignores username/icon_url on file shares, so identity is text-only.
async function post(client, { channel_id, content, files, identity = {}, thread_ts, reply_broadcast, unfurl, postAt, ephemeralUser }) {
  if (files.length === 0) {
    const params = { channel: channel_id, ...content };
    if (thread_ts) params.thread_ts = thread_ts;
    if (ephemeralUser) {
      const res = await client.chat.postEphemeral({ ...params, ...identity, user: ephemeralUser });
      return { message_ts: res.message_ts ?? null };
    }
    if (reply_broadcast) params.reply_broadcast = true;
    if (typeof unfurl === 'boolean') Object.assign(params, { unfurl_links: unfurl, unfurl_media: unfurl });
    if (postAt !== undefined) {
      const res = await client.chat.scheduleMessage({ ...params, post_at: postAt });
      return { scheduled_message_id: res.scheduled_message_id, post_at: res.post_at ?? postAt };
    }
    const msg = await client.chat.postMessage({ ...params, ...identity });
    return { ts: msg.ts ?? null };
  }
  const uploadParams = {
    channel_id,
    file_uploads: files.map((p) => ({ file: fs.createReadStream(p), filename: path.basename(p) })),
  };
  if (content?.blocks) uploadParams.blocks = content.blocks;
  else if (content?.markdown_text) uploadParams.blocks = [{ type: 'markdown', text: content.markdown_text }];
  else if (content?.text) uploadParams.initial_comment = content.text;
  if (thread_ts) uploadParams.thread_ts = thread_ts;
  const startedAt = Date.now() / 1000;
  const file_ids = extractFileIds(await client.files.uploadV2(uploadParams));
  return { ts: await resolveShareTs(client, file_ids[0], channel_id, thread_ts, startedAt), file_ids };
}

function extractFileIds(uploadRes) {
  const ids = [];
  // files_upload_v2 returns { ok, files: [...] } or { ok, file: {...} } depending on shape.
  if (Array.isArray(uploadRes?.files)) {
    for (const entry of uploadRes.files) {
      if (entry?.id) ids.push(entry.id);
      if (Array.isArray(entry?.files)) {
        for (const f of entry.files) if (f?.id) ids.push(f.id);
      }
    }
  } else if (uploadRes?.file?.id) {
    ids.push(uploadRes.file.id);
  }
  return ids;
}

async function resolveShareTs(client, fileId, channelId, threadTs, startedAt) {
  if (!fileId) return null;
  // files.info shares can lag right after completeUploadExternal returns
  // (race), and the shape differs across channel kinds. Scanning the channel's
  // recent history for the file id is more reliable — the file is always part
  // of the share message we just posted. The share message itself can also
  // take a moment to appear in history, so this retries for about 3 s.
  // A thread reply isn't in conversations.history, so a threaded upload is
  // looked up among the thread's replies posted since the upload started.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
    try {
      const res = threadTs
        ? await client.conversations.replies({ channel: channelId, ts: threadTs, oldest: String(startedAt - 60), limit: 50 })
        : await client.conversations.history({ channel: channelId, limit: 10 });
      for (const m of res.messages ?? []) {
        const files = m.files ?? [];
        if (files.some((f) => f?.id === fileId)) return m.ts ?? null;
      }
    } catch {
      return null;
    }
  }
  return null;
}

// Each token can only edit its own messages, so a bot failure retries as
// the user, the same way slack_send does.
async function handleEdit(args) {
  const { channel_id, ts, text, agent_signature, format } = args;
  if (!channel_id || !ts || typeof text !== 'string') {
    return errorResult('channel_id, ts, and text are all required');
  }
  const formatError = checkFormat(format);
  if (formatError) return errorResult(formatError);
  const markdown = format !== 'mrkdwn';
  let res = null;
  let edited_as = 'bot';
  let bot_error;
  if (bot) {
    try {
      res = await bot.chat.update({ channel: channel_id, ts, ...messageContent(text, markdown) });
    } catch (err) {
      bot_error = formatSlackError(err);
    }
  }
  if (!res) {
    edited_as = 'user';
    try {
      res = await slack.chat.update({ channel: channel_id, ts, ...(await userContent(text, agent_signature, markdown)) });
    } catch (err) {
      return errorResult(formatSlackError(err), bot_error ? { bot_error } : undefined);
    }
  }
  if (res.ts && res.channel) recordSend({ ts: res.ts, channel: res.channel });
  return ok({ channel_id: res.channel, ts: res.ts, edited_as });
}

async function handleHistory(args) {
  const { target, limit, thread_ts, before_ts, after_ts, cursor } = args;
  if (!isValidTarget(target)) {
    return errorResult('target is required (string or non-empty array of strings)');
  }
  const cap = thread_ts ? 1000 : 100;
  const fallback = 20;
  let n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : fallback;
  if (n < 1) n = 1;
  if (n > cap) n = cap;

  const { resolution, reader } = await resolveConversation(target);
  if (resolution.error) return ok(resolution);
  const channel_id = resolution.channel_id;

  const params = { channel: channel_id, limit: n };
  if (before_ts) params.latest = before_ts;
  if (after_ts) params.oldest = after_ts;
  if (cursor) params.cursor = cursor;
  const res = thread_ts
    ? await reader.conversations.replies({ ...params, ts: thread_ts })
    : await reader.conversations.history(params);
  const raw = res.messages ?? [];

  const base = await workspaceUrl();
  const messages = await Promise.all(raw.map((m) => shapeMessage(m, channel_id, base)));
  return ok({
    channel_id,
    resolved_target: { type: resolution.type, display: resolution.display },
    messages,
    has_more: !!res.has_more,
    next_cursor: res.response_metadata?.next_cursor || null,
  });
}

async function handleMarkRead(args) {
  const { target, ts, thread_ts } = args;
  if (!isValidTarget(target)) {
    return errorResult('target is required (string or non-empty array of strings)');
  }
  if (typeof ts !== 'string' || !TS_PATTERN.test(ts)) return errorResult(`ts must be a Slack timestamp like 1794248982.212609 (got ${JSON.stringify(ts)})`);
  if (thread_ts !== undefined && (typeof thread_ts !== 'string' || !TS_PATTERN.test(thread_ts))) {
    return errorResult(`thread_ts must be a Slack timestamp (got ${JSON.stringify(thread_ts)})`);
  }

  const resolution = await resolveSendTarget(slack, await expandMe(target));
  if (resolution.error) return ok(resolution);
  const channel_id = resolution.channel_id;

  const result = await markRead(slack, { channel: channel_id, ts, thread_ts });
  return ok({ channel_id, resolved_target: { type: resolution.type, display: resolution.display }, ...result });
}

async function shapeMessage(m, channel_id, base) {
  const user = m.user ? await lookupUserName(slack, m.user) : null;
  const out = {
    ts: m.ts ?? null,
    user: m.user ?? null,
    user_name: user?.name ?? user?.real_name ?? null,
    text: m.text ?? '',
    permalink: m.ts ? buildPermalink(base, channel_id, m.ts, m.thread_ts) : null,
  };
  if (m.thread_ts) out.thread_ts = m.thread_ts;
  if (m.reply_count) {
    out.reply_count = m.reply_count;
    out.reply_users_count = m.reply_users_count ?? null;
    out.latest_reply = m.latest_reply ?? null;
  }
  if (m.subtype) out.subtype = m.subtype;
  if (m.bot_id) out.bot_id = m.bot_id;
  if (m.edited) out.edited = { user: m.edited.user ?? null, ts: m.edited.ts ?? null };
  if (Array.isArray(m.files) && m.files.length > 0) {
    out.files = m.files.map((f) => ({
      id: f.id ?? null,
      name: f.name ?? null,
      mimetype: f.mimetype ?? null,
      url_private: f.url_private ?? null,
      permalink: f.permalink ?? null,
    }));
  }
  if (Array.isArray(m.reactions) && m.reactions.length > 0) {
    out.reactions = m.reactions.map((r) => ({
      name: r.name ?? null,
      count: r.count ?? 0,
      users: Array.isArray(r.users) ? r.users : [],
    }));
  }
  return out;
}

async function handleListenInstructions(args = {}) {
  // Re-establish the runtime tokens file before reporting (self-heals if
  // something removed it since startup).
  const refreshed = ensureRuntimeTokens();
  if (refreshed) RUNTIME_TOKENS_PATH = refreshed;
  // Best-effort re-ensure of the singleton — bring it back up if it died
  // since server boot (e.g. after a network blip + crash).
  const singletonStatus = await ensureSingleton().catch((err) => ({ error: err.message }));

  const flags = args ?? {};
  const watch_self = flags.watch_self === true;
  const include_subtypes = flags.include_subtypes === true;
  const channel = typeof flags.channel === 'string' && flags.channel ? flags.channel : null;
  const thread = typeof flags.thread === 'string' && flags.thread ? flags.thread : null;

  const tokensPath = runtimeTokensPath();
  return ok({
    monitor: buildMonitor({ watch_self, include_subtypes, channel, thread }),
    stream_binary_path: STREAM_BINARY_PATH,
    stream_binary_exists: fs.existsSync(STREAM_BINARY_PATH),
    filters: { watch_self, include_subtypes, channel, thread },
    singleton: {
      alive: singletonAlive(),
      pid: singletonPid(),
      heartbeat_age_ms: heartbeatAgeMs(),
      events_file_path: eventsPath(),
      events_file_present: fs.existsSync(eventsPath()),
      log_path: listenerLogPath(),
      ensure_result: singletonStatus,
    },
    runtime_tokens_path: tokensPath,
    runtime_tokens_file_present: !!RUNTIME_TOKENS_PATH && fs.existsSync(tokensPath),
    recent_sends_path: recentSendsPath(),
    recent_sends_ttl_ms: DEFAULT_TTL_MS,
    notes: [
      'Architecture: one singleton listener daemon per machine owns the Slack Socket Mode connection and writes shaped events to events.jsonl. The Monitor command runs a per-agent stream binary that tails+filters that file. Each agent gets its own filtered stdout; the singleton is shared.',
      'Echoes of our own slack_send / slack_edit posts (as the user or as the bot) are deduped at the singleton before they reach events.jsonl (TTL 5 min, match on (channel, ts)). You never see your own posts come back regardless of watch_self. Other posts by the bot count as is_self, like the user\'s.',
      'watch_self:true surfaces events authored by the token-holder (the human, when typing in Slack client on a channel/MPIM the Slack platform delivers events for). Note: self-typed DMs are platform-quirky in user-token Socket Mode — Slack may not deliver them depending on channel kind. The flag controls our filtering; it does not change what Slack delivers.',
      'include_subtypes:true surfaces edits, joins, bot_message, etc. Default drops them. File shares, thread broadcasts and /me messages from people always pass.',
      'A click on a slack_send button arrives as kind "button_click", with the message\'s channel and ts, user (the clicker), action_id, value and form ({ field id: value }). Clicks pass regardless of watch_self, so the human\'s own clicks arrive too.',
      'channel / thread are server-side filtered by the per-agent binary, so unrelated events never reach your stdout. Use thread to follow a single conversation.',
      'Tokens are NOT placed on any command line; the server publishes them to runtime_tokens_path (mode 0600 in $XDG_RUNTIME_DIR), and the singleton reads them as a fallback when its own env is stripped (Monitor child semantics).',
      'If the singleton is dead at call time, the server tries to re-spawn it inline. The singleton.ensure_result field reports what happened.',
    ],
  });
}

async function handleFileDownload(args) {
  const { file_id, url, dest_path, overwrite } = args;
  if ((!file_id || typeof file_id !== 'string') && (!url || typeof url !== 'string')) {
    return errorResult('one of file_id or url is required');
  }

  let resolvedUrl = typeof url === 'string' ? url : null;
  let name = null;
  let mimetype = null;
  let infoSize = null;

  let token = USER_TOKEN;
  if (file_id) {
    let info;
    try {
      info = await slack.files.info({ file: file_id });
    } catch (err) {
      // The user token can't see files shared only where the bot is, such as people's DMs with the bot.
      if (!bot || err.data?.error !== 'file_not_found') throw err;
      info = await bot.files.info({ file: file_id });
      token = BOT_TOKEN;
    }
    const f = info.file;
    if (!f) return errorResult(`files.info returned no file for id=${file_id}`);
    if (!resolvedUrl) resolvedUrl = f.url_private ?? null;
    name = f.name ?? null;
    mimetype = f.mimetype ?? null;
    if (typeof f.size === 'number') infoSize = f.size;
  }

  if (!resolvedUrl) {
    return errorResult(`could not resolve a download URL${file_id ? ` for file_id=${file_id}` : ''}`);
  }

  // Pick destination path.
  // - dest_path absent → /tmp/<filename>
  // - dest_path is an existing directory or ends with "/" → join with filename
  // - otherwise treat dest_path as the full file path
  const fallbackName = name || (file_id ? `${file_id}.bin` : path.basename(new URL(resolvedUrl).pathname) || 'slack-file.bin');
  let target;
  if (typeof dest_path !== 'string' || dest_path.length === 0) {
    target = path.join(os.tmpdir(), fallbackName);
  } else {
    let isDirHint = dest_path.endsWith('/') || dest_path.endsWith(path.sep);
    if (!isDirHint) {
      try {
        const st = fs.statSync(dest_path);
        if (st.isDirectory()) isDirHint = true;
      } catch (_) {
        // not present — treat as full file path
      }
    }
    target = isDirHint ? path.join(dest_path, fallbackName) : dest_path;
  }
  if (!path.isAbsolute(target)) {
    return errorResult(`dest_path must be absolute (got ${target})`);
  }

  if (!overwrite && fs.existsSync(target)) {
    return errorResult(`dest_path already exists: ${target} (pass overwrite:true to replace)`);
  }

  // Ensure parent directory exists.
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });

  // Authenticated GET. url_private requires a Bearer token that can see the file; without it Slack
  // serves a login HTML page (200) instead of the file bytes.
  const get = (tok) => fetch(resolvedUrl, { headers: { Authorization: `Bearer ${tok}` }, redirect: 'follow' });
  let res = await get(token);
  if (!file_id && bot && (!res.ok || (res.headers.get('content-type') || '').includes('text/html'))) {
    res = await get(BOT_TOKEN);
  }
  if (!res.ok) {
    return errorResult(`download failed: HTTP ${res.status} ${res.statusText} for ${resolvedUrl}`);
  }
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('text/html')) {
    return errorResult(
      `download returned HTML (likely auth/scope issue — ensure files:read is on the user and bot tokens and reinstall the app). content-type=${ctype}`,
    );
  }
  if (!res.body) {
    return errorResult('download returned no body');
  }

  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(target));

  const stat = fs.statSync(target);
  return ok({
    file_id: file_id ?? null,
    name,
    mimetype,
    size: stat.size,
    expected_size: infoSize,
    dest_path: target,
  });
}

async function handleResolve(args) {
  const { target, profile } = args;
  if (typeof target !== 'string' || target.length === 0) {
    return errorResult('target is required');
  }
  if (profile) {
    const r = await resolveUserId(slack, target);
    if (r.error) return ok(r);
    return ok({ profile: await userInfo(slack, r.user_id) });
  }
  const result = await searchTargets(slack, await expandMe(target));
  return ok(result);
}

async function handleSearch(args) {
  const { query, content = 'messages', sort = 'score', sort_dir = 'desc', limit, page } = args;
  if (typeof query !== 'string' || !query.trim()) return errorResult('query is required');
  if (!['messages', 'files'].includes(content)) return errorResult(`content must be "messages" or "files" (got ${JSON.stringify(content)})`);
  if (!['score', 'timestamp'].includes(sort)) return errorResult(`sort must be "score" or "timestamp" (got ${JSON.stringify(sort)})`);
  if (!['desc', 'asc'].includes(sort_dir)) return errorResult(`sort_dir must be "desc" or "asc" (got ${JSON.stringify(sort_dir)})`);
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), SEARCH_MAX_LIMIT) : 20;
  const p = typeof page === 'number' && Number.isFinite(page) ? Math.max(Math.floor(page), 1) : 1;
  return ok(await searchSlack(slack, { query: query.trim(), content, sort, sort_dir, limit: n, page: p }));
}

const labelCache = new Map();
// A conversation's name for people, from whichever token can see it.
async function conversationLabel(channel_id) {
  if (labelCache.has(channel_id)) return labelCache.get(channel_id);
  for (const client of [slack, bot].filter(Boolean)) {
    try {
      const { channel } = await client.conversations.info({ channel: channel_id });
      const label = await conversationDisplay(channel, (id) => lookupUserName(slack, id));
      labelCache.set(channel_id, label);
      return label;
    } catch {
      // try the next token
    }
  }
  return channel_id;
}

async function handleDelete(args) {
  const { channel_id, ts, scheduled_message_id } = args;
  if (typeof channel_id !== 'string' || !channel_id) return errorResult('channel_id is required');
  if ((ts === undefined) === (scheduled_message_id === undefined)) {
    return errorResult('pass exactly one of ts (a posted message) or scheduled_message_id (a scheduled one)');
  }
  if (ts !== undefined && (typeof ts !== 'string' || !TS_PATTERN.test(ts))) return errorResult(`ts must be a Slack timestamp like 1794248982.212609 (got ${JSON.stringify(ts)})`);
  if (scheduled_message_id !== undefined && (typeof scheduled_message_id !== 'string' || !scheduled_message_id)) {
    return errorResult('scheduled_message_id must be a non-empty string');
  }

  const where = await conversationLabel(channel_id);
  const [action, label] = ts ? ['delete', `message ${ts} in ${where}`] : ['cancel', `scheduled message ${scheduled_message_id} in ${where}`];
  const auth = verifyAuthorization(action, label);
  if (!auth.authorized) return errorResult(refusal(action, label, auth), { required_phrase: auth.requiredPhrase });

  const remove = (client) =>
    ts ? client.chat.delete({ channel: channel_id, ts }) : client.chat.deleteScheduledMessage({ channel: channel_id, scheduled_message_id });
  let deleted_as = null;
  let bot_error;
  if (bot) {
    try {
      await remove(bot);
      deleted_as = 'bot';
    } catch (err) {
      bot_error = formatSlackError(err);
    }
  }
  if (!deleted_as) {
    try {
      await remove(slack);
      deleted_as = 'user';
    } catch (err) {
      return errorResult(formatSlackError(err), bot_error ? { bot_error } : undefined);
    }
  }
  return ok({ channel_id, ...(ts ? { ts } : { scheduled_message_id }), conversation: where, deleted_as });
}

async function handleScheduled(args) {
  const { target } = args;
  let channel;
  if (target !== undefined) {
    if (!isValidTarget(target)) return errorResult('target must be a string or non-empty array of strings');
    const { resolution } = await resolveConversation(target);
    if (resolution.error) return ok(resolution);
    channel = resolution.channel_id;
  }
  const sources = [...(bot ? [{ client: bot, as: 'bot' }] : []), { client: slack, as: 'user' }];
  const scheduled = await listScheduled(sources, { channel });
  for (const m of scheduled) m.channel = await conversationLabel(m.channel_id);
  return ok({ scheduled });
}

async function handleUnreads(args) {
  const { days = DEFAULT_DAYS, include_muted = false } = args;
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0 || days > MAX_DAYS) {
    return errorResult(`days must be a number above 0 and at most ${MAX_DAYS} (got ${JSON.stringify(days)})`);
  }
  return ok(
    await findUnreads(slack, {
      selfId: await selfUserId(),
      lookupName: (id) => lookupUserName(slack, id),
      days,
      includeMuted: include_muted === true,
    }),
  );
}

async function handleSetStatus(args) {
  const { status_text, status_emoji, status_expiration, presence, dnd_minutes } = args;
  if ([status_text, status_emoji, status_expiration, presence, dnd_minutes].every((v) => v === undefined)) {
    return errorResult('pass at least one of status_text, status_emoji, status_expiration, presence or dnd_minutes');
  }
  if (status_text !== undefined && typeof status_text !== 'string') return errorResult('status_text must be a string');
  if (status_emoji !== undefined && (typeof status_emoji !== 'string' || !/^(:[^:\s]+:)?$/.test(status_emoji))) {
    return errorResult(`status_emoji must be an emoji code like ":calendar:", or "" to clear it (got ${JSON.stringify(status_emoji)})`);
  }
  let expiration;
  if (status_expiration !== undefined) {
    expiration = parsePostAt(status_expiration);
    if (expiration === null) {
      return errorResult(`status_expiration must be Unix seconds, 0, or an ISO 8601 time with an offset (got ${JSON.stringify(status_expiration)})`);
    }
  }
  if (presence !== undefined && !['auto', 'away'].includes(presence)) return errorResult(`presence must be "auto" or "away" (got ${JSON.stringify(presence)})`);
  if (dnd_minutes !== undefined && (!Number.isInteger(dnd_minutes) || dnd_minutes < 0)) {
    return errorResult(`dnd_minutes must be a whole number of minutes, 0 or more (got ${JSON.stringify(dnd_minutes)})`);
  }
  const res = await setOwnStatus(slack, { status_text, status_emoji, status_expiration: expiration, presence, dnd_minutes });
  if (res.errors && Object.keys(res).length === 1) return errorResult('nothing changed', { errors: res.errors });
  return ok(res);
}

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr ok; stdout is reserved for MCP framing.
console.error(`slack-mcp: ready (${bot ? 'bot first, user fallback' : 'user-token mode'})`);
