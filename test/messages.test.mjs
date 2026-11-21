import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildPermalink, conversationDisplay, listScheduled, parsePostAt, searchSlack, setOwnStatus, threadTsFromPermalink, userInfo } from '../src/messages.mjs';

const WS = 'https://example.slack.com/';

describe('buildPermalink', () => {
  // Expected values are the shapes chat.getPermalink returned for real messages.
  it('links a top-level message', () => {
    assert.equal(buildPermalink(WS, 'C1', '1794868966.194149'), 'https://example.slack.com/archives/C1/p1794868966194149');
  });

  it('adds thread_ts and cid for a thread reply or parent', () => {
    assert.equal(
      buildPermalink(WS, 'C1', '1794940260.600639', '1794868966.194149'),
      'https://example.slack.com/archives/C1/p1794940260600639?thread_ts=1794868966.194149&cid=C1',
    );
  });

  it('accepts a workspace URL without the trailing slash', () => {
    assert.equal(buildPermalink('https://example.slack.com', 'C1', '1.000001'), 'https://example.slack.com/archives/C1/p1000001');
  });

  it('returns null without a workspace URL', () => {
    assert.equal(buildPermalink(null, 'C1', '1.000001'), null);
  });
});

describe('threadTsFromPermalink', () => {
  it('reads thread_ts from a reply permalink', () => {
    assert.equal(threadTsFromPermalink(`${WS}archives/C1/p1795043764959889?thread_ts=1794011377.962179`), '1794011377.962179');
  });

  it('returns null for a top-level message or a bad URL', () => {
    assert.equal(threadTsFromPermalink(`${WS}archives/C1/p1795043764959889`), null);
    assert.equal(threadTsFromPermalink('not a url'), null);
    assert.equal(threadTsFromPermalink(undefined), null);
  });
});

describe('parsePostAt', () => {
  it('takes Unix seconds as a number or digit string', () => {
    assert.equal(parsePostAt(1795000000), 1795000000);
    assert.equal(parsePostAt(1795000000.9), 1795000000);
    assert.equal(parsePostAt('1795000000'), 1795000000);
  });

  it('takes ISO 8601 with an offset or Z', () => {
    assert.equal(parsePostAt('2026-11-19T09:00:00-08:00'), Date.UTC(2026, 10, 19, 17) / 1000);
    assert.equal(parsePostAt('2026-11-19T17:00:00Z'), Date.UTC(2026, 10, 19, 17) / 1000);
  });

  it('rejects a time without an offset, so the machine timezone never applies silently', () => {
    assert.equal(parsePostAt('2026-11-19T09:00:00'), null);
    assert.equal(parsePostAt('tomorrow'), null);
    assert.equal(parsePostAt(''), null);
    assert.equal(parsePostAt(null), null);
  });
});

describe('searchSlack', () => {
  const match = {
    channel: { id: 'C1', name: 'dev-team', is_channel: true, is_private: true },
    ts: '1795043764.959889',
    user: 'U1',
    username: 'jack',
    text: 'deploy failed',
    permalink: `${WS}archives/C1/p1795043764959889?thread_ts=1794011377.962179`,
  };

  it('shapes message matches and passes the query through', async () => {
    const calls = [];
    const client = {
      search: {
        messages: async (p) => {
          calls.push(p);
          return { messages: { matches: [match], paging: { total: 1, page: 1, pages: 1 } } };
        },
      },
    };
    const res = await searchSlack(client, { query: 'deploy in:#dev-team', sort: 'timestamp', limit: 5 });
    assert.deepEqual(calls, [{ query: 'deploy in:#dev-team', sort: 'timestamp', sort_dir: 'desc', count: 5, page: 1 }]);
    assert.deepEqual(res, {
      total: 1,
      page: 1,
      pages: 1,
      messages: [{
        channel_id: 'C1',
        channel_name: 'dev-team',
        channel_type: 'private_channel',
        ts: '1795043764.959889',
        thread_ts: '1794011377.962179',
        user: 'U1',
        user_name: 'jack',
        text: 'deploy failed',
        permalink: match.permalink,
      }],
    });
  });

  it('searches files with content "files"', async () => {
    const client = {
      search: {
        files: async () => ({
          files: {
            matches: [{ id: 'F1', name: 'a.png', title: 'a', mimetype: 'image/png', size: 3, user: 'U1', created: 1, channels: ['C1'], ims: ['D1'], permalink: 'p', url_private: 'u' }],
            paging: { total: 1, page: 1, pages: 1 },
          },
        }),
      },
    };
    const res = await searchSlack(client, { query: 'png', content: 'files' });
    assert.equal(res.files[0].id, 'F1');
    assert.deepEqual(res.files[0].channels, ['C1', 'D1']);
  });
});

describe('userInfo', () => {
  const client = (presence) => ({
    users: {
      info: async () => ({
        user: {
          id: 'U1', name: 'jack', real_name: 'Jack Smith', tz: 'Asia/Tokyo', tz_label: 'Japan Standard Time',
          is_restricted: true,
          profile: { title: 'PM', email: 'j@example.com', phone: '', status_text: 'Lunch', status_emoji: ':pizza:', status_expiration: 1795000000 },
        },
      }),
      getPresence: async () => {
        if (presence instanceof Error) throw presence;
        return { presence };
      },
    },
  });

  it('returns title, timezone, local time, status and presence', async () => {
    const res = await userInfo(client('away'), 'U1', { now: new Date('2026-11-19T17:30:00Z') });
    assert.equal(res.title, 'PM');
    assert.equal(res.tz, 'Asia/Tokyo');
    assert.match(res.local_time, /2026-11-20, 02:30/);
    assert.equal(res.status_text, 'Lunch');
    assert.equal(res.status_expiration, new Date(1795000000 * 1000).toISOString());
    assert.equal(res.presence, 'away');
    assert.equal(res.phone, null);
    assert.equal(res.is_guest, true);
  });

  it('still returns the profile when presence fails', async () => {
    const res = await userInfo(client(new Error('ratelimited')), 'U1');
    assert.equal(res.presence, null);
    assert.equal(res.name, 'jack');
  });
});

describe('conversationDisplay', () => {
  const lookupName = async (id) => (id === 'U2' ? { name: 'pat' } : null);
  it('names channels, DMs and group DMs', async () => {
    assert.equal(await conversationDisplay({ id: 'C1', name: 'general' }, lookupName), '#general');
    assert.equal(await conversationDisplay({ id: 'D1', is_im: true, user: 'U2' }, lookupName), 'DM with @pat');
    assert.equal(await conversationDisplay({ id: 'D2', is_im: true, user: 'U9' }, lookupName), 'DM with @U9');
    assert.equal(
      await conversationDisplay({ id: 'G1', is_mpim: true, name: 'mpdm-a--b-1', purpose: { value: 'Group messaging with: @sam @alex' } }, lookupName),
      'group DM with @sam @alex',
    );
    assert.equal(await conversationDisplay({ id: 'G2', is_mpim: true, name: 'mpdm-a--b-1', purpose: { value: '' } }, lookupName), 'mpdm-a--b-1');
  });
});

describe('listScheduled', () => {
  const source = (as, pages) => {
    let i = 0;
    return {
      as,
      client: { chat: { scheduledMessages: { list: async (p) => ({ ...pages[i++], params: p }) } } },
    };
  };
  it('merges every token\'s pages, oldest post_at first', async () => {
    const bot = source('bot', [
      { scheduled_messages: [{ id: 'Q2', channel_id: 'C1', post_at: 1795400000, text: 'later' }], response_metadata: { next_cursor: 'n' } },
      { scheduled_messages: [{ id: 'Q3', channel_id: 'C1', post_at: 1795500000, text: 'last' }] },
    ]);
    const user = source('user', [{ scheduled_messages: [{ id: 'Q1', channel_id: 'D1', post_at: 1795300000, text: 'first' }] }]);
    const res = await listScheduled([bot, user]);
    assert.deepEqual(res.map((m) => [m.scheduled_message_id, m.scheduled_as]), [['Q1', 'user'], ['Q2', 'bot'], ['Q3', 'bot']]);
    assert.equal(res[0].post_at, new Date(1795300000 * 1000).toISOString());
  });
});

describe('setOwnStatus', () => {
  const missing = () => Promise.reject(Object.assign(new Error('x'), { data: { error: 'missing_scope' } }));
  it('sets only the parts passed, and reports a failing part without stopping the others', async () => {
    const calls = [];
    const client = {
      users: {
        profile: { set: async (p) => { calls.push(['profile', p]); return { profile: { status_text: 'Out', status_emoji: ':palm_tree:', status_expiration: 1795400000 } }; } },
        setPresence: missing,
      },
      dnd: { setSnooze: async (p) => { calls.push(['snooze', p]); return { snooze_endtime: 1795303600 }; } },
    };
    const res = await setOwnStatus(client, { status_text: 'Out', status_emoji: ':palm_tree:', status_expiration: 1795400000, presence: 'away', dnd_minutes: 60 });
    assert.deepEqual(JSON.parse(calls[0][1].profile), { status_text: 'Out', status_emoji: ':palm_tree:', status_expiration: 1795400000 });
    assert.deepEqual(res.status, { text: 'Out', emoji: ':palm_tree:', expires: new Date(1795400000 * 1000).toISOString() });
    assert.deepEqual(res.dnd, { snoozed_until: new Date(1795303600 * 1000).toISOString() });
    assert.match(res.errors.presence, /users:write/);
    assert.equal(res.presence, undefined);
  });

  it('ends the pause when dnd_minutes is 0', async () => {
    let ended = false;
    const res = await setOwnStatus({ dnd: { endSnooze: async () => { ended = true; return {}; } } }, { dnd_minutes: 0 });
    assert.equal(ended, true);
    assert.deepEqual(res, { dnd: { snoozed_until: null } });
  });
});
