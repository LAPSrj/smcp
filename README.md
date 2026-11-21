# slack-mcp

**Let your AI coding agents talk to you on Slack — as you.**

This is an MCP server for AI agents (Claude Code, Claude Desktop, or any MCP
client) that need a real back-and-forth handoff channel with the human they're
working for. Your agent posts in your real Slack channels and DMs, attaches
screenshots and generated files, reads replies, and responds in-thread — all
under your user account. Pair it with the included Socket Mode listener and
Claude Code's `Monitor` tool, and the agent gets pushed each inbound message
as it arrives, so it can keep going while you're away from your laptop.

What that buys you:

- **Long-running tasks become async.** The agent can run for an hour, share a
  screenshot when it hits something ambiguous, and wait for your reply from
  the bus / kitchen / phone — no terminal required.
- **File handoffs work.** Screenshots, build artifacts, generated images,
  PDFs — uploaded as real Slack file attachments, downloadable both ways
  (`slack_send` for upload, `slack_file_download` for the reverse).
- **It's just Slack.** Threaded replies, mobile notifications, search — the
  conversation lives in tools you already use, not in a bespoke agent UI.

A typical exchange:

```
# agent posts in your DM with the bot (your self-DM without a bot token), attaching a screenshot
slack_send({ target: "@me", text: "PR ready — preview attached", file_paths: ["/tmp/diff.png"] })

# you reply from your phone; the listener emits to the agent's Monitor:
{ "user_name": "alex", "text": "looks good, ship it", "thread_ts": "..." }

# agent reads the thread + responds in-thread
slack_send({ target: "C012345", thread_ts: "...", text: "shipped at abc1234" })
```

## Why a separate MCP for this

The default `mcp__claude_ai_Slack__*` connector can't upload files, and the
Google Drive MCP's `create_file` breaks on binary uploads above ~10K base64
chars. So the moment your agent needs to show you a screenshot, hand over a
generated artifact, or read an image attachment from a Slack thread, it's
stuck. This server fills that gap by going through a Slack **user** OAuth
token (`xoxp-`), so posts land as you — in real channels and DMs — with
files actually attached.

## Posting as a bot

With an optional bot token (`xoxb-`, from the same Slack app), `slack_send`
and `slack_edit` try the bot first, so messages show up under the app's own
name and icon with Slack's APP badge. Reading, resolving and downloading
still use your user token, so the server sees everything you can see.

The bot can only post where it is a member: any public channel (with
`chat:write.public`), private channels it was invited to, and its own DMs.
Slack doesn't let a bot post in a DM between two people or in a group DM,
and returns `channel_not_found` there. When the bot fails for any reason, the
send or edit is retried as you, with the footer (see §Footer). The result says which one
posted (`posted_as` / `edited_as`) and, after a fallback, why the bot failed
(`bot_error`).

To send only as the bot, pass `as: "bot"` to `slack_send`: a person as the
target then means the bot's own DM with them (opened with `im:write`), and
nothing is sent as you if the bot can't post. You can't see that DM in
Slack; replies to it reach the listener through the bot's events.
`as: "user"` always posts as you, and the default `as: "auto"` is the
bot-then-you behavior above.

A channel ID your user token can't see, such as someone's DM with the bot,
is resolved with the bot token instead, so `slack_send` posts there as the
bot and `slack_history` reads it as the bot (`resolved_target.display` is
"bot DM with @name"). The bot needs `im:read` / `mpim:read` for this.

`SLACK_BOT_USERNAME` and `SLACK_BOT_ICON_URL` override the name and icon on
text posts (needs `chat:write.customize`). Slack ignores them on file
uploads, which always show the app's own name and icon. Leave them unset to
use the name and icon from the app's Basic Information page.

## Tools

### `slack_send`

```ts
slack_send(
  target: string | string[],        // single ref, or array of 2-8 user refs (MPIM)
  text?: string,
  file_paths?: string[],
  thread_ts?: string,
  format?: "markdown" | "mrkdwn",   // default "markdown"
  reply_broadcast?: boolean,        // with thread_ts: also show the reply in the channel
  unfurl?: boolean,                 // link and media previews on/off; omit for Slack's default
  post_at?: number | string,        // schedule: Unix seconds or ISO 8601 with an offset
  visible_to?: string,              // ephemeral: only this person sees it (@handle, user ID, email, @me)
  buttons?: { id, label, style?: "primary" | "danger", value? }[],   // 1-25, one row under the text
  form?: { id, label, type?, options?, initial?, placeholder? }[],    // 1-40 fields; type defaults to "text"
  replies?: "single" | "multiple" | "poll",  // default "single"; "multiple": one reply per person; "poll": pick one, changeable
  poll_layout?: "by_person" | "by_answer",   // poll table: a row per person (default), or a column per answer
  poll_note?: string,               // poll: label of an optional note field, shown as a Note column
)
  → { channel_id, ts, permalink, file_ids?, posted_as: "bot" | "user", bot_error?, resolved_target, reply_watch: { hint, monitor } }
  → with post_at: { channel_id, scheduled_message_id, post_at, scheduled_as: "bot" | "user", bot_error?, resolved_target }
  → with visible_to: { channel_id, message_ts, visible_to: { user_id, display }, posted_as: "bot" | "user", bot_error?, resolved_target }
  → on miss/ambiguity: { error: "no_match" | "ambiguous" | "not_a_user" | "too_many_users", input, candidates: [...], hint, failed_input?, more_available? }
```

`target` accepts either a single reference:

- `#channel-name`
- channel ID (`C…` / `G…`)
- `@me` — your DM with the bot when a bot token is set, so the bot's messages
  notify you and your replies reach the listener; your self-DM without one
- `@handle`
- user ID (`U…` / `W…`)
- email address
- bare string (searches both channels and users)

…or an **array of 2-8 user references** — in which case slack-mcp opens an
MPIM (group DM) for that user set via `conversations.open` and posts to the
returned channel. Each element must resolve to a user; mixing in a channel
ref returns `not_a_user`. Self is silently dropped (Slack auto-includes the
caller), and duplicate IDs are deduped. `conversations.open` is idempotent,
so passing the same user set repeatedly returns the same MPIM channel — no
new conversation is created. A length-1 array is treated the same as the
equivalent single string.

On a unique single match, posts text via `chat.postMessage`. If `file_paths`
is non-empty, it instead uploads all files via `files_upload_v2` as one
message, with the text as its comment. With `thread_ts`, either kind of post
goes into that thread. The result's `permalink` is the message's Slack link.

Text is sent as standard Markdown by default (`format: "markdown"`):
`**bold**`, `~~strike~~`, `[text](url)`, tables and headings, through
`markdown_text`, or as a `markdown` block on a file upload. `format:
"mrkdwn"` is Slack's own syntax, which is how earlier versions sent
everything. Mentions (`<@U…>`, `<#C…>`, `<!here>`) and `<url|text>` links
work in both. Only `*bold*` (italic in Markdown) and `~strike~` (literal
tildes in Markdown) need `"mrkdwn"`.

`post_at` schedules the message with `chat.scheduleMessage` instead of
sending it now, as the bot first and then as you, like a normal send. Slack
needs the time in the future and at most 120 days out. An ISO time without
an offset is rejected, so the machine's timezone never applies by accident.
The result has `scheduled_message_id` and no `ts`. `slack_scheduled` lists
the pending ones and `slack_delete` cancels one. `post_at`,
`reply_broadcast` and `unfurl` work on text messages only, not with
`file_paths`.

`visible_to` posts an ephemeral message with `chat.postEphemeral`: only that
person sees it, in the conversation `target` names, and they must be a member
of it. It goes out as the bot first and then as you, like a normal send. Slack
shows it only while the person has Slack open and drops it when they reload,
so the result has `message_ts` and no `permalink` or `reply_watch`. It works
on text messages only, not with `file_paths`, `post_at`, `reply_broadcast`,
`unfurl`, `buttons` or `form`.

`buttons` and `form` add buttons and form fields under the text, as Block
Kit `actions` and `input` blocks. A field's `type` is `text`, `multiline`,
`number`, `select`, `multi_select`, `checkboxes`, `radio`, `date`,
`time`, `user` or `channel`; the four choice types take `options`. A form
without `buttons` gets a Submit button with id `submit`. A click on any
button reaches the listener as a `button_click` event (see §Listener) with
the button's `action_id` and `value`, the clicker, and `form`: every field's
value by field id. Slack doesn't enforce required fields in messages, so an
empty field arrives as `null` (`[]` for the list types) and the agent checks
the values.

After the listener writes a click to `events.jsonl`, it replaces the message
through the click's `response_url`. With `replies: "single"` (the default),
each field becomes its answer as text and the buttons go away, so a message
takes one click. If the row had several
buttons, a line names the one clicked. In a channel or group DM, where anyone
can click, the line says `Replied by` and the person's full name. Names go
in without `@`, so they don't become mentions that notify anyone. The message changes only after
the click is saved, so a form that doesn't change means the listener never
got the click (Slack then shows its own error on the button). To report the
outcome, the agent edits the message with `slack_edit`, which replaces the
whole message, answers included.

With `replies: "multiple"`, for a channel or group DM where several people
should answer, the fields and buttons stay. After each reply the buttons are
hidden from that person with the button's `visible_to_user_ids`, which lists
everyone else in the conversation (fetched with `conversations.members` on
the first reply), and a `Replied by` line lists everyone who replied. Someone
who joins the conversation later doesn't see the buttons.

With `replies: "poll"` (buttons only, one per choice, no form), each person
picks one choice and can change it later. The first pick replaces "No replies
yet" with a Slack data table of everyone's pick, sortable and searchable,
and a count per choice under it, both above the buttons. `poll_layout:
"by_person"` (the default) has a Name and an Answer column, one row per
person, grouped by answer. `"by_answer"` has one column per choice with the
names under it. `poll_note` adds an optional note field above the buttons,
labelled with its value (e.g. `"Note"`), for things like "in after lunch". A
pick saves whatever is in the field at that moment (up to 100 characters), an
empty field clears it, and the table shows it in a Note column, or as
"Name (note)" in the `by_answer` layout. Each person's row of buttons has a
block_id of `poll:<user ID>|<name>|<note>`, name and note URI-encoded and the
note cut to fit Slack's 255-character limit, so the message itself holds
everyone's name, pick and note. Each person who picked gets their own copy of the buttons, shown
only to them with `visible_to_user_ids`, with their pick in the primary
style. The shared row shows only to the members who haven't picked yet.
Slack leaves about 8 px of blank space for each row a viewer can't see, so
only the first 10 people who pick get their own row, which keeps that space
under 80 px. Everyone after them keeps the shared row without their pick
highlighted, and still appears in the table. Every click, a change included,
reaches the agent as a `button_click` event.

Buttons and forms work on text messages, including scheduled and ephemeral
ones, but not with `file_paths`. `replies` `"multiple"` and `"poll"` don't
work on ephemeral messages. A click on an ephemeral message doesn't
include the message, so `slack_send` saves an ephemeral form in
`ephemeral-forms.jsonl` (see §Runtime files) and the listener rebuilds it from
there. Slack drops an ephemeral message when the page reloads, form included.
Buttons and forms need **Interactivity** turned on in the Slack app (see
§Setup).

Every successful send returns `reply_watch`, a reminder plus a ready-to-run
`Monitor` spec (same shape as `slack_listen_instructions`) filtered with
`--channel <channel_id>`. An agent that expects an answer starts it right
after sending, unless a Monitor it already runs covers that channel. The
filter is channel-only so the agent gets both top-level replies and thread
replies. `--thread` would drop top-level replies, which is how people usually
answer in DMs.

On a typo or partial name, returns up to 10 candidates with `target_id`s — the
agent re-calls `slack_send` with one of those `target_id`s. For array form,
the offending entry is reported as `failed_input`. No separate resolver round
trip required.

### `slack_edit`

```ts
slack_edit(channel_id: string, ts: string, text: string, format?: "markdown" | "mrkdwn")   // default "markdown"
  → { channel_id, ts, edited_as: "bot" | "user" }
```

Calls `chat.update`. Slack only lets each token edit its own messages, so it
tries the bot token first and then the user token; the user token's API
error is surfaced verbatim if both fail. `text`
fully replaces the previous text (this is not a delta API), and the edit
removes any buttons and form fields `slack_send` added. For threaded
replies, `ts` is the reply's own `ts` (not the parent `thread_ts`).

### `slack_history`

```ts
slack_history(
  target: string | string[],
  limit?: number,
  thread_ts?: string,
  before_ts?: string,
  after_ts?: string,
  cursor?: string,
)
  → { channel_id, resolved_target, messages: Message[], has_more: boolean, next_cursor: string | null }
  → on miss/ambiguity: { error, candidates, hint, more_available? }   // same shape as slack_send
```

`target` follows the same rules as `slack_send` — a single reference, or an
array of 2-8 user refs (resolved to the corresponding MPIM, idempotently).

- Without `thread_ts`: recent messages in the channel/DM via
  `conversations.history`, newest first.
- With `thread_ts`: full reply set via `conversations.replies`, oldest first
  (Slack returns the parent as the first item — preserved).
- `before_ts` and `after_ts` bound the time range (the API's `latest` and
  `oldest`). `after_ts` reads what is new since a message.
- `cursor` takes `next_cursor` from the previous result for the next page.
- `limit` defaults to 20, capped at 100, or 1000 with `thread_ts`.

`Message` shape:

```ts
{
  ts: string,
  user: string | null,            // U…
  user_name: string | null,       // resolved display name
  text: string,
  permalink: string,              // same link chat.getPermalink returns
  thread_ts?: string,
  reply_count?: number,           // thread parents only, with reply_users_count and latest_reply
  subtype?: string,               // "bot_message", "file_share", "channel_join", …
  bot_id?: string,
  edited?: { user, ts },
  files?: [{ id, name, mimetype, url_private, permalink }],
  reactions?: [{ name, count, users: string[] }]
}
```

Subtype-bearing messages (joins, edits, file shares) are **not** filtered —
the agent decides what's relevant.

### `slack_mark_read`

```ts
slack_mark_read(target: string | string[], ts: string, thread_ts?: string)
  → { channel_id, resolved_target, marked: true, scope, previous_last_read, last_read }
  → { channel_id, resolved_target, marked: false, scope, reason: "already_read" | "last_read_unknown", last_read }
```

Marks messages as read for you, moving the read position forward only.
`target` follows the same rules as `slack_history`.

- Top-level message (no `thread_ts`, or `thread_ts == ts`): calls
  `conversations.mark`, which moves the channel's read position to `ts`.
  Needs `channels:write`, `groups:write`, `im:write` or `mpim:write` for the
  channel kind.
- Thread reply (`thread_ts != ts`): calls `subscriptions.thread.mark`, which
  moves the thread's read position. Slack doesn't document this method (it's
  the one the Slack client uses), and it works with the history scopes.

Before marking, it reads the current position (`conversations.info`
`last_read` for a channel, the parent's `last_read` from
`conversations.replies` for a thread). If `ts` isn't newer, or Slack doesn't
report a position, nothing changes and `reason` says why.

### `slack_file_download`

```ts
slack_file_download(
  file_id?: string,        // F… — preferred; calls files.info to get url_private + name
  url?: string,            // direct https://files.slack.com/… url_private
  dest_path?: string,      // absolute file path, or absolute directory (uses original filename)
  overwrite?: boolean,     // default false → error if dest_path exists
)
  → { file_id, name, mimetype, size, expected_size, dest_path }
```

Downloads a Slack-hosted file (typically an attachment surfaced via
`slack_history` or the listener) to local disk. The GET against `url_private`
is authenticated with the user OAuth token, or with the bot token for files
only the bot can see (people's DMs with the bot); without `files:read` Slack
returns a login HTML page rather than the bytes — this tool detects that and fails
loudly rather than writing HTML to disk.

One of `file_id` / `url` is required. `file_id` is preferred — `files.info`
recovers the original filename and mimetype, which the response surfaces back.
With only `url`, the response carries `name: null, mimetype: null`.

`dest_path` is **recommended**. Pass an absolute file path, or an absolute
directory (trailing `/` or an existing dir → original filename appended). If
omitted, the file lands in `/tmp/<filename>` — fine for an immediate `Read`,
but `/tmp` is ephemeral; specify a real directory for anything you want to
keep.

### `slack_listen_instructions`

```ts
slack_listen_instructions(
  watch_self?: boolean,        // include events authored by the token-holder (default: drop)
  channel?: string,            // filter to one channel ID
  thread?: string,             // filter to one thread (matches thread_ts or parent ts)
  include_subtypes?: boolean,  // include edits / joins / bot_message etc. (people's file shares,
                               // thread broadcasts and /me messages always pass)
)
  → {
    monitor: { command, description, persistent, timeout_ms },
    stream_binary_path: string,
    stream_binary_exists: boolean,
    filters: { watch_self, include_subtypes, channel, thread },
    singleton: {
      alive, pid, heartbeat_age_ms,
      events_file_path, events_file_present,
      log_path, ensure_result,
    },
    runtime_tokens_path, runtime_tokens_file_present,
    recent_sends_path, recent_sends_ttl_ms,
    notes: string[],
  }
```

Returns the `Monitor()` parameters needed to consume the Slack event stream.
The architecture has two pieces: ONE singleton listener daemon per machine
owns the Slack Socket Mode connection and writes shaped events to
`events.jsonl`; each agent's `Monitor` invokes a per-agent stream binary
(`scripts/slack-listen-stream.mjs`) that tails+filters that file. The MCP
server ensures the singleton is running at boot, and re-ensures on each
call to this tool. See §Listener below for the full model.

Pass the returned `monitor` object straight into Claude Code's `Monitor`
tool. The filters baked into the returned command live on the per-agent
binary, so two agents in different tabs get independently-filtered streams
off the same shared singleton.

### `slack_resolve`

```ts
slack_resolve(target: string, profile?: boolean)
  → { matches: [{ target_id, type, display, name?, real_name?, email?, title?, topic?, purpose?, num_members?, is_archived? }, …], more_available? }
  → with profile: { profile: { id, name, real_name, display_name, title, email, phone, tz, tz_label, local_time,
                               status_text, status_emoji, status_expiration, presence, is_bot, is_admin, is_guest, deleted } }
```

Same engine as the `slack_send` fallback, plus matches on a channel's topic
or purpose and a person's job title, ranked after name matches. Archived
channels are listed last with `is_archived: true` (`slack_send` skips them).

With `profile: true` and a target that names one person (`@me` is you here,
not the bot DM), it returns that person's profile, including their local time
now and presence (`active` / `away`). When the target matches several people,
it returns the candidates instead.

### `slack_search`

```ts
slack_search(
  query: string,                    // Slack search syntax, e.g. 'deploy in:#dev-team after:2026-11-01'
  content?: "messages" | "files",   // default "messages"
  sort?: "score" | "timestamp",     // default "score"
  sort_dir?: "desc" | "asc",        // default "desc"
  limit?: number,                   // default 20, capped at 100
  page?: number,                    // default 1
)
  → { total, page, pages, messages: [{ channel_id, channel_name, channel_type, ts, thread_ts?, user, user_name, text, permalink, files? }] }
  → with content "files": { total, page, pages, files: [{ id, name, title, mimetype, size, user, created, channels, permalink, url_private }] }
```

Calls `search.messages` or `search.files` with your user token (needs
`search:read`), so it covers every conversation you can see: public and
private channels, DMs and group DMs. `query` takes Slack's modifiers
(`in:`, `from:`, `with:`, `has:`, `is:thread`, `before:`, `after:`, `on:`,
`during:`). A thread reply's `thread_ts` comes from its permalink, since
the search API doesn't return it as a field. It is keyword search only,
without the claude.ai connector's semantic ranking.

### `slack_delete`

```ts
slack_delete(channel_id: string, ts?: string, scheduled_message_id?: string)   // exactly one of ts / scheduled_message_id
  → { channel_id, ts, conversation, deleted_as: "bot" | "user" }
  → { channel_id, scheduled_message_id, conversation, deleted_as: "bot" | "user" }
  → not authorized yet: { error, required_phrase }
```

Deletes a posted message with `chat.delete`, or cancels a scheduled one with
`chat.deleteScheduledMessage`. Each token can only delete its own messages,
so it tries the bot token first and then yours. Slack can't cancel a
scheduled message within 60 seconds of its post time.

Deleting can't be undone, so the tool runs only after you type a sentence
naming the message in the chat, such as:

```
I authorize Slack to delete message 1795000000.000100 in #general
I authorize Slack to cancel scheduled message Q0123ABCDEF in DM with @alex
```

The first call returns that sentence in `required_phrase`, and the agent asks
you to type it. The server then looks for it in the messages you typed, in
the Claude Code transcripts for the server's working directory
(`$CLAUDE_CONFIG_DIR/projects/<folder>/*.jsonl`, or `~/.claude/projects/…`),
so text the agent writes never counts. Set `SLACK_TRANSCRIPT_DIR` to read
the transcripts from another folder.

### `slack_scheduled`

```ts
slack_scheduled(target?: string | string[])   // same references as slack_history
  → { scheduled: [{ scheduled_message_id, channel_id, channel, post_at, text, scheduled_as: "bot" | "user" }] }
```

Lists the messages Slack hasn't posted yet, oldest `post_at` first, with
`chat.scheduledMessages.list` for the bot token and for yours. Slack returns
only the messages each token scheduled itself, so messages you schedule in the
Slack app don't appear. Slack can't edit a scheduled message, so to change one,
cancel it with `slack_delete` and schedule the new text with `slack_send`.

### `slack_unreads`

```ts
slack_unreads(days?: number, include_muted?: boolean)   // days: default 7, at most 30
  → { since, complete, checked, conversations: Unread[], failed?: [{ channel_id, error }] }
```

`Unread` shape:

```ts
{
  channel_id: string,
  display: string,           // "#general", "DM with @alex", "group DM with @alex @sam @pat"
  type: "public_channel" | "private_channel" | "im" | "mpim",
  unread_count: number,
  mentions: number,          // unread messages with <@you>; @here, @channel and group mentions don't count
  last_read: string,         // pass as after_ts to slack_history to read them
  newest: { ts, user, user_name, text, permalink }   // text cut to 200 characters
}
```

Lists the channels, DMs and group DMs you're in that have messages newer
than your read position, newest first. Slack reports unread counts only for
DMs, and checking each conversation one by one is slow (about 400
conversations took two minutes, mostly waiting out rate limits). So it
searches for messages from the last `days` days with `search.messages` and
calls `conversations.info` only for the conversations that had any.

- Unread messages older than the window, and messages Slack hasn't indexed
  yet, are missed. `complete: false` means the window had
  more than 2,000 messages, so try fewer days.
- Your own messages and thread replies don't count, because neither changes
  what Slack shows as unread in the channel. So an unread thread reply,
  even one that mentions you, isn't reported.
- Muted channels are skipped unless `include_muted` is true.
- Conversations only the bot is in (people's DMs with the bot) aren't
  included.
- `failed` lists conversations `conversations.info` refused, such as a DM
  with a deactivated account.

### `slack_set_status`

```ts
slack_set_status(
  status_text?: string,              // "" clears it
  status_emoji?: string,             // ":calendar:"; "" clears it
  status_expiration?: number | string,   // Unix seconds or ISO 8601 with an offset; 0 = never
  presence?: "auto" | "away",
  dnd_minutes?: number,              // pause notifications; 0 ends the pause
)
  → { status?: { text, emoji, expires }, presence?, dnd?: { snoozed_until }, errors?: { status?, presence?, dnd? } }
```

Sets your own status (`users.profile.set`, needs `users.profile:write`),
presence (`users.setPresence`, needs `users:write`) and Do Not Disturb
(`dnd.setSnooze` / `dnd.endSnooze`, needs `dnd:write`). Pass only what
should change. A part that fails, such as one whose scope is missing, is
listed under `errors` and the others still apply. If every part fails, the
call returns an error. `slack_resolve("@me", profile: true)` shows the
current status and presence.

## Setup

### 1. Create the Slack app

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**.
   Name it (e.g. `claude-self`) and pick the target workspace.
2. **Socket Mode** → enable. Generate an app-level token with the
   `connections:write` scope. Save the `xapp-…` token — this is
   `SLACK_APP_TOKEN`. Then turn on **Interactivity & Shortcuts**, so clicks
   on `slack_send` buttons reach the listener. With Socket Mode it needs no
   Request URL.
3. **OAuth & Permissions** → under **User Token Scopes**, add:
   - `chat:write`
   - `files:write`
   - `im:write`
   - `mpim:write`         *(open MPIMs / group DMs — slack_send & slack_history when target is an array of users)*
   - `users:read`
   - `users:read.email`
   - `channels:read`
   - `groups:read`
   - `mpim:read`
   - `im:read`
   - `channels:history`   *(slack_history on public channels)*
   - `groups:history`     *(slack_history on private channels)*
   - `im:history`         *(slack_history on DMs)*
   - `mpim:history`       *(slack_history on group DMs)*
   - `reactions:read`     *(reactions on history results)*
   - `files:read`         *(slack_file_download — files.info + url_private GET)*
   - `groups:write`       *(slack_mark_read on private channels; it also allows archive, rename, invite and kick in private channels you're in)*
   - `channels:write`     *(slack_mark_read on public channels; it also allows creating, archiving and renaming public channels and inviting and removing people)*
   - `search:read`        *(slack_search, slack_unreads)*
   - `users.profile:write` *(slack_set_status: status text, emoji and expiration)*
   - `users:write`        *(slack_set_status: presence)*
   - `dnd:write`          *(slack_set_status: Do Not Disturb)*

   **If you add scopes after the initial install, you must reinstall the app
   to the workspace** (Settings → Install App → Reinstall). When `groups:write`
   was added this way, the existing `xoxp-…` token stayed valid and gained the
   new scope (check the `x-oauth-scopes` header of `auth.test`). If the token
   shown on the OAuth page does change, copy the new one into
   `SLACK_USER_TOKEN`.
   For the optional bot (see §Posting as a bot), also add under **Bot Token
   Scopes**:
   - `chat:write`
   - `chat:write.public`    *(post in public channels without an invite)*
   - `chat:write.customize` *(only for `SLACK_BOT_USERNAME` / `SLACK_BOT_ICON_URL`)*
   - `files:write`
   - `channels:history`, `groups:history`, `im:history`, `mpim:history`
     *(bot events below, and finding the ts of a file the bot posted)*
   - `im:read`, `mpim:read` *(reading people's DMs with the bot)*
   - `im:write` *(opening the bot's DM with someone, for `as: "bot"`)*
   - `files:read` *(slack_file_download for files people send the bot)*
4. **Event Subscriptions** → enable. Under **Subscribe to events on behalf
   of users**, add:
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`

   For the bot, add the same four under **Subscribe to bot events**, so the
   listener also gets messages in conversations only the bot is in (people
   writing to it directly, public channels you aren't in). For people to
   write to the bot, turn on **App Home → Messages Tab** and allow users to
   send messages from it. Set the bot's name and icon under **Basic
   Information → Display Information**.
5. **Install App** → install to the workspace. Copy the **User OAuth Token**
   (`xoxp-…`) — this is `SLACK_USER_TOKEN` — and, with bot scopes, the **Bot
   User OAuth Token** (`xoxb-…`) — this is `SLACK_BOT_TOKEN`.
6. For private channels you want the MCP to post into, manually invite your
   user (the token holder is you).

### 2. Install dependencies

```bash
cd <repo-path>
npm install
```

Requires Node ≥ 20.12. `<repo-path>` is wherever you cloned this repo; substitute
its absolute path in the snippets below.

### 3. Configure environment

Put the two tokens in one of these places. The server and the listener check
them in this order and use the first one that has a token:

1. The `env` block of the MCP server config (next step).
2. A `.env` file in the repo root: copy `.env.example` to `.env` and fill it
   in. It can also set `SLACK_SEND_FOOTER` and the other optional settings.
3. One file per token under `~/.config/slack-mcp/`, the same layout the
   Kinsta and BugHerd MCPs use. Then the MCP config doesn't need an `env`
   block at all:

   ```bash
   mkdir -p -m 700 ~/.config/slack-mcp
   install -m 600 /dev/null ~/.config/slack-mcp/user-token
   install -m 600 /dev/null ~/.config/slack-mcp/app-token
   install -m 600 /dev/null ~/.config/slack-mcp/bot-token   # optional
   # then paste xoxp-… into user-token, xapp-… into app-token and xoxb-… into bot-token
   ```

   Set `SLACK_USER_TOKEN_FILE`, `SLACK_APP_TOKEN_FILE` or
   `SLACK_BOT_TOKEN_FILE` to read a token from a different path.

### 4. Register the MCP server

Add to `~/.claude/settings.json` under `mcpServers` (leave out `env` if the
tokens are in `.env` or `~/.config/slack-mcp/`):

```json
{
  "mcpServers": {
    "slack": {
      "command": "node",
      "args": ["<repo-path>/src/server.mjs"],
      "env": {
        "SLACK_USER_TOKEN": "xoxp-…",
        "SLACK_APP_TOKEN": "xapp-…"
      }
    }
  }
}
```

Then restart Claude Code. Tools appear as `mcp__slack__slack_send`, etc.

> `SLACK_APP_TOKEN` is used by the listener, not the MCP server itself. The
> server still needs to find it, because it publishes both tokens to a runtime
> file (see §Listener) that the listener reads when Monitor starts it with an
> empty env and the tokens are only in the MCP config.

### 5. Use it from a session

```
mcp__slack__slack_send({ target: "@alex", text: "test", file_paths: ["/tmp/foo.png"] })
```

## Listener (singleton + per-agent stream)

The listener is split into two pieces:

1. **Singleton daemon** — `scripts/slack-listen.mjs`. One per machine + user
   token. Owns the Slack Socket Mode connection, dedups echoes of our own
   `slack_send` / `slack_edit` posts (as you or as the bot), drops a message
   Slack delivers twice (once for the user and once for the bot
   subscription), and appends shaped+enriched events to `events.jsonl`.
   With a bot token it marks the bot's own posts `is_self: true`, so the
   self filter treats them like yours. A post of ours that isn't in
   `recent-sends.jsonl` yet is checked again 6 s later, because a file
   send is recorded only after its ts is found in history; so self events
   reach `--watch-self` consumers about 6 s late. Spawned automatically when the MCP server boots or
   when any per-agent stream binary boots — `ensureRunning()` is idempotent
   and race-safe (concurrent boots only produce one daemon).
2. **Per-agent stream binary** — `scripts/slack-listen-stream.mjs`. One
   process per `Monitor` invocation. Tails `events.jsonl` (rotation-aware
   via inode tracking), applies the agent's filters (`--watch-self` /
   `--no-self` / `--channel` / `--thread` / `--include-subtypes`), and
   writes survivors to stdout. No Socket Mode connection of its own.

**Why this shape:** Slack Socket Mode load-balances events across all
WebSocket clients connected with the same App token. The previous
per-tab-listener design meant N MCP tabs → events sharded ~1/N, so each
agent saw only its fraction. Worse, orphan listeners from crashed sessions
held shares forever and silently stole events from live ones. The singleton
collapses everything to one WebSocket, so every event hits the one consumer
that fans out via `events.jsonl`.

### Calling it from a session

Easiest path: ask the MCP for the invocation.

```
slack_listen_instructions({ watch_self: true, channel: "C012345" })
  → {
    monitor: {
      command: "node <…>/scripts/slack-listen-stream.mjs --watch-self --channel C012345",
      description: "Slack",
      persistent: true,
      timeout_ms: 3600000,
    },
    singleton: { alive: true, pid: 12345, heartbeat_age_ms: 4, … },
    …
  }
```

Pass the returned `monitor` object straight into Claude Code's `Monitor` tool.
Each stdout line is one shaped JSON event:

```json
{
  "ts": "1715000000.123456",
  "channel": "C0123456789",
  "channel_name": "#general",
  "user": "U0123456789",
  "user_name": "alice",
  "user_real_name": "Alice Example",
  "is_self": false,
  "text": "hi there",
  "thread_ts": null,
  "subtype": null,
  "bot_id": null,
  "files": [{ "id": "F…", "name": "foo.png", "mimetype": "image/png", "url": "https://files.slack.com/…" }]
}
```

A click on a `slack_send` button arrives as the same shape with `kind:
"button_click"`, the message's `ts` and `channel` (so `--channel` and
`--thread` filter clicks the way they filter replies), the clicker as
`user`, `text` like `clicked "Approve"`, and these extra fields:

```json
{
  "kind": "button_click",
  "action_id": "approve",
  "value": "deploy-42",
  "form": { "note": "Fixes the login bug", "env": "production", "when": null }
}
```

Clicks pass without `--watch-self`, because the human's own clicks are the
ones an agent usually waits for.

Synthetic events for stream-health detection appear as
`{"event":"slack_connected","at":<ms>}` and `{"event":"slack_disconnected","at":<ms>,"error":…}` —
these always pass through any filter so consumers can detect gaps.

### Run directly (debugging)

```bash
# Run the singleton manually (it will refuse to start a second one — heartbeat check):
SLACK_USER_TOKEN=xoxp-… SLACK_APP_TOKEN=xapp-… node scripts/slack-listen.mjs

# Tail it via the stream binary in another shell:
node scripts/slack-listen-stream.mjs --watch-self
```

To bring up the singleton without writing your own command, just call
`slack_listen_instructions()` once — the MCP server ensures it on each call.

### Runtime files

All under `$XDG_RUNTIME_DIR/slack-mcp/` (or `/tmp/slack-mcp-<uid>/`
if `XDG_RUNTIME_DIR` is unset), parent dir `0700`, every file `0600`.

| File | Owner | Purpose |
|---|---|---|
| `tokens.env` | MCP server | Tokens for the singleton (Monitor strips child env; this is the fallback) |
| `recent-sends.jsonl` | MCP servers (shared) | Echo-suppression. Each successful `slack_send`/`slack_edit` appends `{ts,channel,sent_at}`; singleton drops matching events before they reach `events.jsonl`. TTL 5 min. |
| `ephemeral-forms.jsonl` | MCP servers (shared) | Each ephemeral `slack_send` with buttons or a form, so the singleton can replace it after a click (Slack leaves the message out of the click). Kept a day. |
| `listener.heartbeat` | Singleton | mtime touched every 10s; ensureRunning treats >30s as dead |
| `listener.pid` | Singleton | Diagnostic — current singleton's pid |
| `listener.spawn.lock` | ensureRunning | O_EXCL ephemeral lock during spawn; prevents concurrent double-spawn |
| `listener.log` | Singleton | Singleton's stderr (boot, errors, rotation events) |
| `events.jsonl` | Singleton | Append-only event stream consumed by stream binaries. Rotated to `events.1.jsonl` at 5 MB (two-segment scheme) |
| `events.1.jsonl` | Singleton | Previous segment; transparently followed by in-flight stream binaries via inode tracking |
| `stream-heartbeats/<pid>.heartbeat` | Stream binaries | One per active subscriber; diagnostic only |

### Permission UX

Grant `Bash` permission once for the named stream binary:

```
node <repo-path>/scripts/slack-listen-stream.mjs *
```

(Wildcard covers all filter combinations.) Every agent's `Monitor` call
from `slack_listen_instructions()` matches this pattern — no per-call
permission prompts.

### Watch-self caveat (Slack platform)

`watch_self: true` toggles whether the stream binary surfaces events
where `is_self: true` (the token-holder authored them). It does NOT
change what Slack delivers over Socket Mode. Empirically (2026-05-25),
user-token Socket Mode does NOT reliably deliver `message.im` events
authored by the token-holder via the Slack client — so a self-typed
DM may not arrive regardless of this flag. File-share events from
the same user DO arrive. Behavior in `message.channels` /
`message.mpim` / `message.groups` is unclear; treat watch-self as
"do not filter" rather than "guarantee delivery." Echoes of our own
`slack_send` are always suppressed at the singleton level before they
reach the stream binary, so you never see your own posts come back.

### Token handoff (Monitor strips env)

Monitor spawns child processes with a stripped environment, so a
Monitor-launched stream binary does **not** inherit `SLACK_USER_TOKEN` /
`SLACK_APP_TOKEN` from the session. The stream binary doesn't need them
directly (it just reads `events.jsonl`), but it does spawn the singleton
on first boot — and the singleton DOES need them. The MCP server writes
its tokens to `tokens.env` at startup so the singleton can read them as
an env-stripped child. If the tokens are in the repo `.env` or under
`~/.config/slack-mcp/`, the singleton reads them from there first.

- **Path**: `$XDG_RUNTIME_DIR/slack-mcp/tokens.env`
- **Mode**: file `0600`, parent dir `0700`. On a logged-in Linux session
  `$XDG_RUNTIME_DIR` is itself a `0700` tmpfs that gets cleared at logout.
- **Format**: dotenv-style `KEY=value` lines.
- **Precedence**: `process.env` wins. If you set the env vars in the
  spawning shell, the file is never read.

`slack_listen_instructions()` surfaces `runtime_tokens_path` and
`runtime_tokens_file_present` so an agent debugging a "tokens missing"
error can see whether the file is where it expects.

> Threat model: this protects against unrelated processes on the same
> machine snooping `ps`/`environ`. It does **not** protect against another
> process running as the same user — but at that point the attacker can
> read `~/.claude.json` directly anyway.

## Done means

1. `slack_send("@alex", "test", ["/tmp/foo.png"])` from a Claude Code
   session posts as the human user with the PNG attached.
2. The listener, run via `Monitor`, surfaces a structured JSON event when a
   test message is sent in Slack from another device.
3. Round-trip thread reply: the listener emits an event carrying
   `thread_ts` → the agent calls `slack_history(target=channel_id, thread_ts=parent_ts)`
   → gets the full thread context → calls
   `slack_send(target=channel_id, thread_ts=parent_ts, text=…)` and the reply
   lands in-thread.

## Footer

Every message posted as you gets a footer so recipients can tell it came
through automation. It is a context block, the small grey line under the
message that Slack's own MCP uses for "Sent using Claude":

```
your message text
Sent using L.E.O
```

The name is the app's name from its Basic Information page, read once with
`bots.info` through the bot token's `bot_id`. Without a bot token, the
footer says "Sent using AI". Override or disable it via env:

- `SLACK_SEND_FOOTER="*Sent using* Claude"`: custom footer text (Slack mrkdwn)
- `SLACK_SEND_FOOTER=""`: no footer

The footer is only added when the caller-supplied text is non-empty (so
file-only uploads with no caption stay caption-less). `slack_edit` adds it
again, so editing doesn't remove it.

A Markdown message with the footer is sent as a `markdown` block, which
Slack converts to rich text. Its `text`, which Slack shows in notifications
and screen readers, is the same Markdown converted to Slack's mrkdwn with
[marked](https://marked.js.org/)'s parser, plus the footer. Mentions
(`<@U…>`, `<#C…>`, `<!here>`) and `<url|text>` links are kept as they
are. A `format: "mrkdwn"` message is sent as section blocks, split at line
breaks every 3000 characters (Slack's limit per section), and its `text` is
the original text plus the footer.

### Agent signature

Both `slack_send` and `slack_edit` accept an optional `agent_signature` string.
If set, it is added in parentheses at the end of the footer:

```
your message text
Sent using L.E.O (Claude Code)
```

This is opt-in, so agents that want to identify themselves can. If
`SLACK_SEND_FOOTER` is empty, the signature is also suppressed (no footer
at all).

> Note: Slack already shows the app's name in the sidebar preview of a post
> made as you, but not in the message itself, so the footer is what
> recipients see in the conversation. Posts made as the bot (see §Posting as
> a bot) show the bot's name and the APP badge, so they get no footer and
> `agent_signature` is ignored for them.
## Notes / gotchas

- `files_upload_v2` requires channel **IDs**, not names — the resolver always
  produces an ID before calling it.
- The token holder must be a member of the channel they're posting into.
  For private channels, invite yourself first, and invite the bot too if it
  should post there as itself.
- The channel and user lists behind name lookups are refetched every 10
  minutes, and sooner when a name isn't found, so a new channel can be
  addressed by name without restarting the server. A name that resolved
  once keeps its ID for the server's lifetime.
- This MCP has no reactions, canvases or drafts. Use the
  `mcp__claude_ai_Slack__*` connector for those.

## Files

```
slack-mcp/
├── package.json
├── README.md
├── LICENSE
├── .env.example
├── src/
│   ├── server.mjs               # MCP stdio server (slack_send / edit / delete / history / mark_read / scheduled / unreads / set_status / file_download / resolve / search / listen_instructions)
│   ├── messages.mjs             # permalinks, search results, user profiles, post_at parsing, scheduled lists, status
│   ├── unreads.mjs              # search-driven unread check for slack_unreads
│   ├── auth-guard.mjs           # typed-authorization check for slack_delete
│   ├── mrkdwn.mjs               # Markdown → mrkdwn notification text, message blocks with footer
│   ├── controls.mjs             # slack_send buttons and form fields, the values a click reports, the message after a click
│   ├── ephemeral-forms.mjs      # saved ephemeral forms, for the listener to replace after a click
│   ├── mark-read.mjs            # forward-only read-position marking for slack_mark_read
│   ├── config.mjs               # loads tokens from env → repo .env → ~/.config/slack-mcp/
│   ├── resolver.mjs             # target → channel ID + fuzzy candidates
│   ├── runtime-tokens.mjs       # tokens.env handoff (server → singleton)
│   ├── recent-sends.mjs         # recent-sends.jsonl shared dedup for echo suppression
│   └── listener-singleton.mjs   # ensureRunning/heartbeat/path constants for the one-daemon-per-machine model
├── scripts/
│   ├── slack-listen.mjs         # Singleton listener daemon — owns Socket Mode, writes events.jsonl
│   └── slack-listen-stream.mjs  # Per-agent stream binary — tails+filters events.jsonl for one Monitor session
└── test/
    ├── auth-guard.test.mjs
    ├── config.test.mjs
    ├── controls.test.mjs
    ├── ephemeral-forms.test.mjs
    ├── recent-sends.test.mjs
    ├── listener-singleton.test.mjs
    ├── mark-read.test.mjs
    ├── messages.test.mjs
    ├── mrkdwn.test.mjs
    ├── resolver.test.mjs
    ├── unreads.test.mjs
    └── slack-listen-stream.test.mjs    # run all: `npm test`
```

## License

[PolyForm Strict License 1.0.0](LICENSE.md)
