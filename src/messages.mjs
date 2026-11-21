// Permalinks, search, user profiles, scheduled messages and status for the slack_* tools.

// Same URL chat.getPermalink returns, built locally to skip one API call per message.
export function buildPermalink(workspaceUrl, channel, ts, thread_ts) {
  if (!workspaceUrl || !channel || !ts) return null;
  const base = workspaceUrl.endsWith('/') ? workspaceUrl : `${workspaceUrl}/`;
  const url = `${base}archives/${channel}/p${ts.replace('.', '')}`;
  return thread_ts ? `${url}?thread_ts=${thread_ts}&cid=${channel}` : url;
}

// search.messages matches have no thread_ts field; a reply's permalink carries it.
export function threadTsFromPermalink(permalink) {
  if (!permalink) return null;
  try {
    return new URL(permalink).searchParams.get('thread_ts');
  } catch {
    return null;
  }
}

export function channelType(c = {}) {
  if (c.is_im) return 'im';
  if (c.is_mpim) return 'mpim';
  return c.is_private || c.is_group ? 'private_channel' : 'public_channel';
}

export function shapeSearchMessage(m) {
  const out = {
    channel_id: m.channel?.id ?? null,
    channel_name: m.channel?.name ?? null,
    channel_type: channelType(m.channel),
    ts: m.ts ?? null,
    user: m.user ?? null,
    user_name: m.username ?? null,
    text: m.text ?? '',
    permalink: m.permalink ?? null,
  };
  const thread_ts = threadTsFromPermalink(m.permalink);
  if (thread_ts) out.thread_ts = thread_ts;
  if (Array.isArray(m.files) && m.files.length > 0) {
    out.files = m.files.map((f) => ({ id: f.id ?? null, name: f.name ?? null, mimetype: f.mimetype ?? null }));
  }
  return out;
}

export function shapeSearchFile(f) {
  return {
    id: f.id ?? null,
    name: f.name ?? null,
    title: f.title ?? null,
    mimetype: f.mimetype ?? null,
    size: f.size ?? null,
    user: f.user ?? null,
    created: f.created ?? null,
    channels: [...(f.channels ?? []), ...(f.groups ?? []), ...(f.ims ?? [])],
    permalink: f.permalink ?? null,
    url_private: f.url_private ?? null,
  };
}

export const SEARCH_MAX_LIMIT = 100;

export async function searchSlack(client, { query, content = 'messages', sort = 'score', sort_dir = 'desc', limit = 20, page = 1 }) {
  const params = { query, sort, sort_dir, count: limit, page };
  if (content === 'files') {
    const res = await client.search.files(params);
    const paging = res.files?.paging ?? {};
    return {
      total: paging.total ?? 0,
      page: paging.page ?? page,
      pages: paging.pages ?? 0,
      files: (res.files?.matches ?? []).map(shapeSearchFile),
    };
  }
  const res = await client.search.messages(params);
  const paging = res.messages?.paging ?? {};
  return {
    total: paging.total ?? 0,
    page: paging.page ?? page,
    pages: paging.pages ?? 0,
    messages: (res.messages?.matches ?? []).map(shapeSearchMessage),
  };
}

// Unix seconds from a number, a digit string, or an ISO 8601 time with an
// explicit offset (without one, the machine's timezone would silently apply).
export function parsePostAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function localTime(tz, now) {
  if (!tz) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    }).format(now);
  } catch {
    return null;
  }
}

export async function userInfo(client, userId, { now = new Date() } = {}) {
  const [{ user: u }, presence] = await Promise.all([
    client.users.info({ user: userId }),
    client.users.getPresence({ user: userId }).catch(() => null),
  ]);
  const p = u.profile ?? {};
  return {
    id: u.id,
    name: u.name ?? null,
    real_name: u.real_name ?? p.real_name ?? null,
    display_name: p.display_name || null,
    title: p.title || null,
    email: p.email ?? null,
    phone: p.phone || null,
    tz: u.tz ?? null,
    tz_label: u.tz_label ?? null,
    local_time: localTime(u.tz, now),
    status_text: p.status_text || null,
    status_emoji: p.status_emoji || null,
    status_expiration: p.status_expiration ? new Date(p.status_expiration * 1000).toISOString() : null,
    presence: presence?.presence ?? null,
    is_bot: !!u.is_bot,
    is_admin: !!u.is_admin,
    is_guest: !!(u.is_restricted || u.is_ultra_restricted),
    deleted: !!u.deleted,
  };
}

// A conversation's name for people: #channel, "DM with @pat", or the group
// DM's member list, which Slack keeps in its purpose ("Group messaging with: @a @b").
export async function conversationDisplay(c, lookupName) {
  if (c.is_im) {
    const u = c.user ? await lookupName(c.user) : null;
    return `DM with @${u?.name ?? c.user ?? c.id}`;
  }
  if (c.is_mpim) {
    const who = c.purpose?.value?.replace(/^[^:]*:\s*/, '').trim();
    return who ? `group DM with ${who}` : c.name ?? c.id;
  }
  return c.name ? `#${c.name}` : c.id;
}

// Slack lists only the messages a token scheduled itself, so each token that
// can schedule (bot and user) is asked separately.
export async function listScheduled(sources, { channel } = {}) {
  const out = [];
  for (const { client, as } of sources) {
    let cursor;
    do {
      const res = await client.chat.scheduledMessages.list({ ...(channel && { channel }), limit: 100, cursor });
      for (const m of res.scheduled_messages ?? []) {
        out.push({
          scheduled_message_id: m.id,
          channel_id: m.channel_id,
          post_at: new Date(m.post_at * 1000).toISOString(),
          text: (m.text ?? '').trimEnd(),
          scheduled_as: as,
        });
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }
  return out.sort((a, b) => a.post_at.localeCompare(b.post_at));
}

function scopeError(err, scope) {
  const code = err.data?.error ?? err.message;
  return code === 'missing_scope'
    ? `missing_scope: the user token needs ${scope}. Add it under User Token Scopes and reinstall the app.`
    : code;
}

const isoOrNull = (secs) => (secs ? new Date(secs * 1000).toISOString() : null);

// Each part (status, presence, Do Not Disturb) needs its own scope, so one
// failing doesn't stop the others; failures are listed under errors.
export async function setOwnStatus(client, { status_text, status_emoji, status_expiration, presence, dnd_minutes }) {
  const out = {};
  const errors = {};
  const profile = Object.fromEntries(
    Object.entries({ status_text, status_emoji, status_expiration }).filter(([, v]) => v !== undefined),
  );
  if (Object.keys(profile).length > 0) {
    try {
      const { profile: p = {} } = await client.users.profile.set({ profile: JSON.stringify(profile) });
      out.status = { text: p.status_text || null, emoji: p.status_emoji || null, expires: isoOrNull(p.status_expiration) };
    } catch (err) {
      errors.status = scopeError(err, 'users.profile:write');
    }
  }
  if (presence !== undefined) {
    try {
      await client.users.setPresence({ presence });
      out.presence = presence;
    } catch (err) {
      errors.presence = scopeError(err, 'users:write');
    }
  }
  if (dnd_minutes !== undefined) {
    try {
      if (dnd_minutes > 0) {
        const res = await client.dnd.setSnooze({ num_minutes: dnd_minutes });
        out.dnd = { snoozed_until: isoOrNull(res.snooze_endtime) };
      } else {
        await client.dnd.endSnooze();
        out.dnd = { snoozed_until: null };
      }
    } catch (err) {
      errors.dnd = scopeError(err, 'dnd:write');
    }
  }
  return Object.keys(errors).length > 0 ? { ...out, errors } : out;
}
