import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildPermalink, parsePostAt, searchSlack, threadTsFromPermalink, userInfo } from '../src/messages.mjs';

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
