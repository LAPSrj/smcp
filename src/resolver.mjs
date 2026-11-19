// Resolve a free-form target string to a Slack channel ID.
//
// Inputs accepted:
//   #channel-name, C..., G... (channels)
//   @handle, U..., W...        (users → DM via conversations.open)
//   email                      (users.lookupByEmail, then fuzzy)
//   bare string                (search channels + users)
//
// Returns either { channel_id, type, display, ... } on a unique match,
// or { error: 'no_match' | 'ambiguous', input, candidates: [...], hint, more_available? }.
//
// Channel and user lists are refetched after LIST_TTL_MS, and sooner when a
// name finds nothing (a channel created since the last fetch). Resolved
// targets, DM IDs and per-user names are cached for the process lifetime.

const LIST_TTL_MS = 10 * 60_000;
const REFETCH_ON_MISS_AFTER_MS = 30_000;

const CACHE = {
  resolved: new Map(),    // input → { channel_id, type, ... }
  channels: null,         // [{ id, name, is_private, is_im, is_mpim, is_archived, topic, purpose, num_members }]
  channelsAt: 0,
  users: null,            // [{ id, name, real_name, display_name, email, title, is_bot }]
  usersAt: 0,
  dms: new Map(),         // user_id → channel_id
  userById: new Map(),    // user_id → { name, real_name, display_name, email }
  selfUserId: null,       // string — cached auth.test().user_id
};

// Lookup the authenticated user's own ID. Cached for process lifetime.
async function getSelfUserId(client) {
  if (CACHE.selfUserId) return CACHE.selfUserId;
  const res = await client.auth.test();
  CACHE.selfUserId = res.user_id ?? res.user ?? null;
  return CACHE.selfUserId;
}

// Lookup a user by ID for display purposes. Pulls from the bulk list if it's
// already populated (resolver path), otherwise falls back to users.info and
// caches by id. Never throws — returns nulls on failure.
export async function lookupUserName(client, userId) {
  if (!userId) return null;
  if (CACHE.userById.has(userId)) return CACHE.userById.get(userId);
  if (CACHE.users) {
    const hit = CACHE.users.find((u) => u.id === userId);
    if (hit) {
      const entry = { name: hit.name, real_name: hit.real_name, display_name: hit.display_name, email: hit.email };
      CACHE.userById.set(userId, entry);
      return entry;
    }
  }
  try {
    const res = await client.users.info({ user: userId });
    const u = res.user ?? {};
    const entry = {
      name: u.name ?? null,
      real_name: u.real_name ?? u.profile?.real_name ?? null,
      display_name: u.profile?.display_name || u.profile?.display_name_normalized || null,
      email: u.profile?.email ?? null,
    };
    CACHE.userById.set(userId, entry);
    return entry;
  } catch (_) {
    const entry = { name: null, real_name: null, display_name: null, email: null };
    CACHE.userById.set(userId, entry);
    return entry;
  }
}

function clearCachedResolution(input) {
  CACHE.resolved.delete(input);
}

const isFresh = (at, maxAge) => Date.now() - at < maxAge;

async function listAllChannels(client, { maxAge = LIST_TTL_MS } = {}) {
  if (CACHE.channels && isFresh(CACHE.channelsAt, maxAge)) return CACHE.channels;
  const out = [];
  let cursor;
  do {
    const res = await client.conversations.list({
      types: 'public_channel,private_channel,mpim,im',
      exclude_archived: false,
      limit: 1000,
      cursor,
    });
    for (const c of res.channels ?? []) {
      out.push({
        id: c.id,
        name: c.name ?? null,
        is_private: !!c.is_private,
        is_im: !!c.is_im,
        is_mpim: !!c.is_mpim,
        is_archived: !!c.is_archived,
        user: c.user ?? null,
        topic: c.topic?.value || null,
        purpose: c.purpose?.value || null,
        num_members: c.num_members ?? null,
      });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  CACHE.channels = out;
  CACHE.channelsAt = Date.now();
  return out;
}

async function listAllUsers(client, { maxAge = LIST_TTL_MS } = {}) {
  if (CACHE.users && isFresh(CACHE.usersAt, maxAge)) return CACHE.users;
  const out = [];
  let cursor;
  do {
    const res = await client.users.list({ limit: 1000, cursor });
    for (const u of res.members ?? []) {
      if (u.deleted) continue;
      out.push({
        id: u.id,
        name: u.name ?? null,
        real_name: u.real_name ?? u.profile?.real_name ?? null,
        display_name: u.profile?.display_name || u.profile?.display_name_normalized || null,
        email: u.profile?.email ?? null,
        title: u.profile?.title || null,
        is_bot: !!u.is_bot,
      });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  CACHE.users = out;
  CACHE.usersAt = Date.now();
  return out;
}

// Runs search(channels, users); when it finds nothing, refetches lists older
// than REFETCH_ON_MISS_AFTER_MS once and searches again.
async function searchLists(client, { channels: wantChannels, users: wantUsers }, search) {
  const load = (maxAge) => Promise.all([
    wantChannels ? listAllChannels(client, { maxAge }) : [],
    wantUsers ? listAllUsers(client, { maxAge }) : [],
  ]);
  const hits = search(...(await load(LIST_TTL_MS)));
  if (hits.length > 0) return hits;
  return search(...(await load(REFETCH_ON_MISS_AFTER_MS)));
}

async function openDm(client, userId) {
  if (CACHE.dms.has(userId)) return CACHE.dms.get(userId);
  const res = await client.conversations.open({ users: userId });
  const id = res.channel?.id;
  if (!id) throw new Error(`conversations.open returned no channel.id for user ${userId}`);
  CACHE.dms.set(userId, id);
  return id;
}

function scoreMatch(needle, haystack) {
  if (!haystack) return null;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (h === n) return 0;
  if (h.startsWith(n)) return 1;
  if (h.includes(n)) return 2;
  return null;
}

function bestScore(needle, fields) {
  let best = null;
  for (const f of fields) {
    const s = scoreMatch(needle, f);
    if (s !== null && (best === null || s < best)) best = s;
  }
  return best;
}

// A match only in a topic, purpose or title ranks after every name match.
const DESCRIPTION_SCORE = 3;

// extended: also match topic/purpose and report them and archived channels
// (slack_resolve). Without it, archived channels are skipped, since nothing
// can be posted there.
function searchChannels(channels, needle, { extended = false } = {}) {
  const stripped = needle.startsWith('#') ? needle.slice(1) : needle;
  const results = [];
  for (const c of channels) {
    if (c.is_im || c.is_mpim) continue;
    if (!c.name) continue;
    if (c.is_archived && !extended) continue;
    let s = scoreMatch(stripped, c.name);
    if (s === null && extended && bestScore(stripped, [c.topic, c.purpose]) !== null) s = DESCRIPTION_SCORE;
    if (s !== null) {
      const hit = {
        score: s,
        target_id: c.id,
        type: c.is_private ? 'private_channel' : 'public_channel',
        display: `#${c.name}`,
        name: c.name,
      };
      if (extended) Object.assign(hit, { topic: c.topic, purpose: c.purpose, num_members: c.num_members, is_archived: c.is_archived });
      results.push(hit);
    }
  }
  results.sort((a, b) => a.score - b.score || (a.is_archived ? 1 : 0) - (b.is_archived ? 1 : 0));
  return results;
}

function searchUsers(users, needle, { extended = false } = {}) {
  const stripped = needle.startsWith('@') ? needle.slice(1) : needle;
  const results = [];
  for (const u of users) {
    if (u.is_bot) continue; // sends-as-user; bot DMs are noisy
    let s = bestScore(stripped, [u.name, u.display_name, u.real_name, u.email]);
    if (s === null && extended && scoreMatch(stripped, u.title) !== null) s = DESCRIPTION_SCORE;
    if (s !== null) {
      const hit = {
        score: s,
        target_id: u.id,
        type: 'user',
        display: u.name ? `@${u.name}` : `@${u.id}`,
        name: u.name,
        real_name: u.real_name,
        email: u.email,
      };
      if (extended) hit.title = u.title;
      results.push(hit);
    }
  }
  results.sort((a, b) => a.score - b.score);
  return results;
}

function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

const ID_RE = /^[CGDUW][A-Z0-9]{6,}$/;
const CHANNEL_ID_RE = /^[CGD][A-Z0-9]{6,}$/;
const USER_ID_RE = /^[UW][A-Z0-9]{6,}$/;

// Trim 10 candidates max and report whether more existed.
function cap(list, n = 10) {
  if (list.length <= n) return { candidates: list, more_available: false };
  return { candidates: list.slice(0, n), more_available: true };
}

function stripCandidateScores(list) {
  return list.map(({ score, ...rest }) => rest);
}

// Public: resolve a target. Returns { channel_id, type, display, ... } on hit,
// or { error, input, candidates, hint, more_available? } on miss/ambiguity.
export async function resolveTarget(client, rawInput) {
  if (typeof rawInput !== 'string' || rawInput.length === 0) {
    return { error: 'no_match', input: String(rawInput ?? ''), candidates: [], hint: 'target must be a non-empty string' };
  }
  const input = rawInput.trim();
  if (CACHE.resolved.has(input)) return CACHE.resolved.get(input);

  // 1. Already a channel ID — verify membership/access.
  if (CHANNEL_ID_RE.test(input)) {
    try {
      const info = await client.conversations.info({ channel: input });
      const c = info.channel;
      const result = {
        channel_id: c.id,
        type: c.is_im ? 'im' : c.is_mpim ? 'mpim' : c.is_private ? 'private_channel' : 'public_channel',
        display: c.name ? `#${c.name}` : c.id,
        name: c.name ?? null,
      };
      CACHE.resolved.set(input, result);
      return result;
    } catch (err) {
      return {
        error: 'no_match',
        input,
        candidates: [],
        hint: `conversations.info failed for ${input}: ${err.data?.error || err.message}`,
      };
    }
  }

  // 2. Already a user ID — open DM.
  if (USER_ID_RE.test(input)) {
    try {
      const channel_id = await openDm(client, input);
      const users = await listAllUsers(client);
      const u = users.find((x) => x.id === input);
      const result = {
        channel_id,
        type: 'user',
        display: u?.name ? `@${u.name}` : input,
        user_id: input,
        name: u?.name ?? null,
        real_name: u?.real_name ?? null,
      };
      CACHE.resolved.set(input, result);
      return result;
    } catch (err) {
      return {
        error: 'no_match',
        input,
        candidates: [],
        hint: `conversations.open failed for ${input}: ${err.data?.error || err.message}`,
      };
    }
  }

  // 3. Email — try exact lookup first.
  if (looksLikeEmail(input)) {
    try {
      const res = await client.users.lookupByEmail({ email: input });
      const userId = res.user?.id;
      if (userId) {
        const channel_id = await openDm(client, userId);
        const result = {
          channel_id,
          type: 'user',
          display: res.user.name ? `@${res.user.name}` : userId,
          user_id: userId,
          name: res.user.name ?? null,
          real_name: res.user.real_name ?? null,
          email: input,
        };
        CACHE.resolved.set(input, result);
        return result;
      }
    } catch (err) {
      // fall through to fuzzy
      if (err.data?.error && err.data.error !== 'users_not_found') {
        return {
          error: 'no_match',
          input,
          candidates: [],
          hint: `users.lookupByEmail failed: ${err.data.error}`,
        };
      }
    }
  }

  // 4. #channel-name — search channels only.
  if (input.startsWith('#')) {
    const hits = await searchLists(client, { channels: true }, (channels) => searchChannels(channels, input));
    if (hits.length === 1 && hits[0].score === 0) {
      const channel_id = hits[0].target_id;
      const result = { channel_id, type: hits[0].type, display: hits[0].display, name: hits[0].name };
      CACHE.resolved.set(input, result);
      return result;
    }
    const { candidates, more_available } = cap(hits);
    return {
      error: hits.length === 0 ? 'no_match' : 'ambiguous',
      input,
      candidates: stripCandidateScores(candidates),
      more_available,
      hint: 're-call slack_send with target set to one of the target_id values',
    };
  }

  // 5. @handle — search users only.
  if (input.startsWith('@')) {
    const hits = await searchLists(client, { users: true }, (_, users) => searchUsers(users, input));
    return await finalizeUserSearch(client, input, hits);
  }

  // 6. Bare string — search channels + users.
  const merged = await searchLists(client, { channels: true, users: true }, (channels, users) =>
    [...searchChannels(channels, input), ...searchUsers(users, input)].sort((a, b) => a.score - b.score));

  // Exact unique hit shortcut.
  const exact = merged.filter((h) => h.score === 0);
  if (exact.length === 1) {
    const hit = exact[0];
    if (hit.type === 'user') {
      const channel_id = await openDm(client, hit.target_id);
      const result = { channel_id, type: 'user', display: hit.display, user_id: hit.target_id, name: hit.name, real_name: hit.real_name };
      CACHE.resolved.set(input, result);
      return result;
    }
    const result = { channel_id: hit.target_id, type: hit.type, display: hit.display, name: hit.name };
    CACHE.resolved.set(input, result);
    return result;
  }

  const { candidates, more_available } = cap(merged);
  return {
    error: merged.length === 0 ? 'no_match' : 'ambiguous',
    input,
    candidates: stripCandidateScores(candidates),
    more_available,
    hint: 're-call slack_send with target set to one of the target_id values',
  };
}

async function finalizeUserSearch(client, input, hits) {
  if (hits.length === 1 && hits[0].score === 0) {
    const channel_id = await openDm(client, hits[0].target_id);
    const result = {
      channel_id,
      type: 'user',
      display: hits[0].display,
      user_id: hits[0].target_id,
      name: hits[0].name,
      real_name: hits[0].real_name,
    };
    CACHE.resolved.set(input, result);
    return result;
  }
  const { candidates, more_available } = cap(hits);
  return {
    error: hits.length === 0 ? 'no_match' : 'ambiguous',
    input,
    candidates: stripCandidateScores(candidates),
    more_available,
    hint: 're-call slack_send with target set to one of the target_id values',
  };
}

// Public: full search engine, used by slack_resolve.
export async function searchTargets(client, rawInput) {
  if (typeof rawInput !== 'string' || rawInput.length === 0) {
    return { matches: [] };
  }
  const input = rawInput.trim();

  // ID inputs short-circuit to a single match.
  if (CHANNEL_ID_RE.test(input) || USER_ID_RE.test(input)) {
    const r = await resolveTarget(client, input);
    if (r.error) return { matches: [], error: r.error, hint: r.hint };
    return {
      matches: [
        {
          target_id: r.user_id ?? r.channel_id,
          type: r.type,
          display: r.display,
          name: r.name ?? null,
          real_name: r.real_name ?? null,
        },
      ],
    };
  }

  if (looksLikeEmail(input)) {
    try {
      const res = await client.users.lookupByEmail({ email: input });
      if (res.user) {
        return {
          matches: [
            {
              target_id: res.user.id,
              type: 'user',
              display: res.user.name ? `@${res.user.name}` : res.user.id,
              name: res.user.name ?? null,
              real_name: res.user.real_name ?? null,
              email: input,
            },
          ],
        };
      }
    } catch (_) {
      // fall through
    }
  }

  const opts = { extended: true };
  let hits;
  if (input.startsWith('#')) {
    hits = await searchLists(client, { channels: true }, (channels) => searchChannels(channels, input, opts));
  } else if (input.startsWith('@')) {
    hits = await searchLists(client, { users: true }, (_, users) => searchUsers(users, input, opts));
  } else {
    hits = await searchLists(client, { channels: true, users: true }, (channels, users) =>
      [...searchChannels(channels, input, opts), ...searchUsers(users, input, opts)].sort((a, b) => a.score - b.score));
  }
  const { candidates, more_available } = cap(hits);
  return { matches: stripCandidateScores(candidates), more_available };
}

// Public: a user reference (@me, @handle, U…/W…, email, name) to a user ID,
// without opening a DM. Returns { user_id } or { error, input, candidates, hint }.
export async function resolveUserId(client, rawInput) {
  const input = typeof rawInput === 'string' ? rawInput.trim() : '';
  if (!input) return { error: 'no_match', input, candidates: [], hint: 'user must be a non-empty string' };
  if (input.toLowerCase() === '@me') return { user_id: await getSelfUserId(client) };
  if (USER_ID_RE.test(input)) return { user_id: input };
  if (CHANNEL_ID_RE.test(input) || input.startsWith('#')) {
    return { error: 'not_a_user', input, candidates: [], hint: `"${input}" is a channel; pass a person` };
  }
  if (looksLikeEmail(input)) {
    try {
      const res = await client.users.lookupByEmail({ email: input });
      if (res.user?.id) return { user_id: res.user.id };
    } catch (err) {
      if (err.data?.error !== 'users_not_found') throw err;
    }
  }
  const hits = await searchLists(client, { users: true }, (_, users) => searchUsers(users, input));
  if (hits.length === 1 || (hits.length > 1 && hits[0].score === 0 && hits[1].score !== 0)) {
    return { user_id: hits[0].target_id };
  }
  const { candidates, more_available } = cap(hits);
  return {
    error: hits.length === 0 ? 'no_match' : 'ambiguous',
    input,
    candidates: stripCandidateScores(candidates),
    more_available,
    hint: 're-call with user set to one of the target_id values',
  };
}

// Public: resolve a list of user-ish inputs to an MPIM channel (or 1:1 IM if
// only one other user remains after dedupe/self-drop). Each input must resolve
// to a user — anything else (channel, mpim, im) is rejected. Slack's
// conversations.open is idempotent: same user set always returns the same
// MPIM channel id, so repeated calls do not create duplicates.
//
// On success: { channel_id, type: 'mpim' | 'user', display, user_ids }.
// On failure: { error, failed_input?, candidates, hint, more_available? }.
export async function resolveMpim(client, inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return {
      error: 'no_match',
      input: JSON.stringify(inputs ?? null),
      candidates: [],
      hint: 'targets must be a non-empty array of user references',
    };
  }

  // Resolve each input strictly to a user via the existing engine.
  const resolvedIds = [];
  for (const raw of inputs) {
    if (typeof raw !== 'string' || raw.length === 0) {
      return {
        error: 'no_match',
        input: JSON.stringify(inputs),
        failed_input: raw,
        candidates: [],
        hint: 'each target must be a non-empty string',
      };
    }
    const r = await resolveTarget(client, raw);
    if (r.error) {
      return {
        error: r.error,
        input: JSON.stringify(inputs),
        failed_input: raw,
        candidates: r.candidates ?? [],
        more_available: r.more_available,
        hint: r.hint,
      };
    }
    if (r.type !== 'user') {
      return {
        error: 'not_a_user',
        input: JSON.stringify(inputs),
        failed_input: raw,
        candidates: [],
        hint: `target "${raw}" resolves to ${r.type} (${r.display}); MPIM members must be users`,
      };
    }
    resolvedIds.push(r.user_id);
  }

  // Drop self (Slack auto-includes the caller) and dedupe.
  const selfId = await getSelfUserId(client);
  const seen = new Set();
  const userIds = [];
  for (const id of resolvedIds) {
    if (id === selfId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    userIds.push(id);
  }
  if (userIds.length === 0) {
    return {
      error: 'no_match',
      input: JSON.stringify(inputs),
      candidates: [],
      hint: 'no other users in the list — Slack auto-includes you, so the array must name at least one other user',
    };
  }
  if (userIds.length > 8) {
    return {
      error: 'too_many_users',
      input: JSON.stringify(inputs),
      candidates: [],
      hint: `Slack MPIMs cap at 8 other users (9 participants incl. yourself); got ${userIds.length}`,
    };
  }

  const res = await client.conversations.open({ users: userIds.join(',') });
  const channelId = res.channel?.id;
  if (!channelId) {
    throw new Error('conversations.open returned no channel.id for mpim');
  }

  const names = [];
  for (const id of userIds) {
    const u = await lookupUserName(client, id);
    names.push(u?.name ? `@${u.name}` : id);
  }
  return {
    channel_id: channelId,
    type: userIds.length === 1 ? 'user' : 'mpim',
    display: names.join(', '),
    user_ids: userIds,
  };
}

// Public: dispatch for tools whose `target` accepts either a single string
// (existing channel/user/etc.) or an array of user references (open an MPIM).
// Length-1 array degrades to the single-target path so callers can pass
// `["@alice"]` and `"@alice"` interchangeably.
export async function resolveSendTarget(client, target) {
  if (typeof target === 'string') {
    return await resolveTarget(client, target);
  }
  if (Array.isArray(target)) {
    if (target.length === 0) {
      return {
        error: 'no_match',
        input: '[]',
        candidates: [],
        hint: 'target array is empty',
      };
    }
    if (target.length === 1) {
      return await resolveTarget(client, target[0]);
    }
    return await resolveMpim(client, target);
  }
  return {
    error: 'no_match',
    input: String(target ?? ''),
    candidates: [],
    hint: 'target must be a string or array of strings',
  };
}

export const __testing = { CACHE, clearCachedResolution };
