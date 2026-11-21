import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { findUnreads } from '../src/unreads.mjs';

const NOW = 1795300000 * 1000;
const WS = 'https://example.slack.com/archives';
const match = (channel, ts, user, text = 'hi', thread_ts) => ({
  channel: { id: channel },
  ts,
  user,
  username: user.toLowerCase(),
  text,
  permalink: thread_ts ? `${WS}/${channel}/p${ts.replace('.', '')}?thread_ts=${thread_ts}&cid=${channel}` : `${WS}/${channel}/p${ts.replace('.', '')}`,
});

function fakeSlack({ members, pages, info }) {
  const calls = [];
  return {
    calls,
    users: { conversations: async (p) => { calls.push(['users.conversations', p]); return { channels: members }; } },
    search: { messages: async (p) => { calls.push(['search.messages', p]); return { messages: { paging: { pages: pages.length }, matches: pages[p.page - 1] ?? [] } }; } },
    conversations: {
      info: async ({ channel }) => {
        calls.push(['conversations.info', channel]);
        if (!info[channel]) throw Object.assign(new Error('x'), { data: { error: 'channel_not_found' } });
        return { channel: info[channel] };
      },
    },
  };
}

const lookupName = async (id) => ({ name: id.toLowerCase() });

describe('findUnreads', () => {
  it('counts messages after last_read, leaving out the user, thread replies and other conversations', async () => {
    const slack = fakeSlack({
      members: [{ id: 'C1', name: 'general' }, { id: 'D1', is_im: true, user: 'U2' }, { id: 'C3', name: 'quiet' }],
      pages: [[
        match('C1', '1795290000.000300', 'U2', 'hey <@U1>'),
        match('C1', '1795290000.000250', 'U3', 'reply', '1795290000.000100'),
        match('C1', '1795290000.000200', 'U1', 'mine'),
        match('C1', '1795290000.000150', 'U3'),
        match('C1', '1795290000.000100', 'U3', 'already read'),
        match('D1', '1795280000.000100', 'U2', 'dm'),
        match('C3', '1795270000.000100', 'U2', 'read'),
        match('C9', '1795260000.000100', 'U2', 'not a member'),
      ]],
      info: {
        C1: { id: 'C1', name: 'general', last_read: '1795290000.000100' },
        D1: { id: 'D1', is_im: true, user: 'U2', last_read: '0000000000.000000' },
        C3: { id: 'C3', name: 'quiet', last_read: '1795270000.000100' },
      },
    });
    const res = await findUnreads(slack, { selfId: 'U1', lookupName, now: NOW });
    assert.equal(res.complete, true);
    assert.equal(res.checked, 3);
    assert.deepEqual(res.conversations.map((c) => [c.channel_id, c.display, c.type, c.unread_count, c.mentions]), [
      ['C1', '#general', 'public_channel', 2, 1],
      ['D1', 'DM with @u2', 'im', 1, 0],
    ]);
    assert.equal(res.conversations[0].newest.ts, '1795290000.000300');
    assert.equal(slack.calls.find(([m]) => m === 'users.conversations')[1].exclude_muted, true);
  });

  it('stops at the start of the window and drops older matches', async () => {
    const slack = fakeSlack({
      members: [{ id: 'C1', name: 'general' }],
      pages: [[match('C1', '1795290000.000100', 'U2'), match('C1', String(NOW / 1000 - 8 * 86400), 'U2')], [match('C1', '1.000000', 'U2')]],
      info: { C1: { id: 'C1', name: 'general', last_read: '0000000000.000000' } },
    });
    const res = await findUnreads(slack, { selfId: 'U1', lookupName, now: NOW, days: 7 });
    assert.equal(res.conversations[0].unread_count, 1);
    assert.equal(slack.calls.filter(([m]) => m === 'search.messages').length, 1);
  });

  it('reports a conversation Slack refuses to describe under failed', async () => {
    const slack = fakeSlack({
      members: [{ id: 'C1' }],
      pages: [[match('C1', '1795290000.000100', 'U2')]],
      info: {},
    });
    const res = await findUnreads(slack, { selfId: 'U1', lookupName, now: NOW });
    assert.deepEqual(res.failed, [{ channel_id: 'C1', error: 'channel_not_found' }]);
    assert.deepEqual(res.conversations, []);
  });

  it('says the scan is incomplete when the window has more pages than it reads', async () => {
    const page = [match('C1', '1795290000.000100', 'U2')];
    const slack = fakeSlack({ members: [], pages: Array.from({ length: 25 }, () => page), info: {} });
    const res = await findUnreads(slack, { selfId: 'U1', lookupName, now: NOW });
    assert.equal(res.complete, false);
    assert.equal(slack.calls.filter(([m]) => m === 'search.messages').length, 20);
  });
});
