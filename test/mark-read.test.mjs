import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { compareTs, markRead } from '../src/mark-read.mjs';

function fakeSlack({ channelLastRead, threadLastRead } = {}) {
  const calls = [];
  return {
    calls,
    conversations: {
      info: async (p) => { calls.push(['conversations.info', p]); return { channel: { last_read: channelLastRead } }; },
      replies: async (p) => { calls.push(['conversations.replies', p]); return { messages: [{ ts: p.ts, last_read: threadLastRead }] }; },
      mark: async (p) => { calls.push(['conversations.mark', p]); return { ok: true }; },
    },
    apiCall: async (method, p) => { calls.push([method, p]); return { ok: true }; },
  };
}

const writes = (slack) => slack.calls.filter(([m]) => m === 'conversations.mark' || m === 'subscriptions.thread.mark');

describe('compareTs', () => {
  it('orders by seconds, then microseconds', () => {
    assert.equal(compareTs('1794248982.212609', '1794248982.212610'), -1);
    assert.equal(compareTs('1794248983.000000', '1794248982.999999'), 1);
    assert.equal(compareTs('1794248982.2126', '1794248982.212600'), 0);
  });

  it('tells apart values a double would round together', () => {
    assert.equal(compareTs('1794248982.212609', '1794248982.212608'), 1);
  });
});

describe('markRead', () => {
  it('marks a newer top-level message with conversations.mark', async () => {
    const slack = fakeSlack({ channelLastRead: '100.000001' });
    const res = await markRead(slack, { channel: 'C1', ts: '100.000002' });
    assert.deepEqual(res, { marked: true, scope: 'channel', previous_last_read: '100.000001', last_read: '100.000002' });
    assert.deepEqual(writes(slack), [['conversations.mark', { channel: 'C1', ts: '100.000002' }]]);
  });

  it('treats ts == thread_ts as a top-level message', async () => {
    const slack = fakeSlack({ channelLastRead: '100.000001' });
    const res = await markRead(slack, { channel: 'C1', ts: '100.000002', thread_ts: '100.000002' });
    assert.equal(res.scope, 'channel');
    assert.equal(writes(slack)[0][0], 'conversations.mark');
  });

  it('never moves the channel read position backward', async () => {
    const slack = fakeSlack({ channelLastRead: '100.000005' });
    for (const ts of ['100.000004', '100.000005']) {
      const res = await markRead(slack, { channel: 'C1', ts });
      assert.deepEqual(res, { marked: false, scope: 'channel', reason: 'already_read', last_read: '100.000005' });
    }
    assert.deepEqual(writes(slack), []);
  });

  it('marks a newer thread reply with subscriptions.thread.mark', async () => {
    const slack = fakeSlack({ threadLastRead: '100.000003' });
    const res = await markRead(slack, { channel: 'C1', ts: '100.000004', thread_ts: '100.000001' });
    assert.equal(res.marked, true);
    assert.equal(res.scope, 'thread');
    assert.deepEqual(writes(slack), [['subscriptions.thread.mark', { channel: 'C1', thread_ts: '100.000001', ts: '100.000004', read: 1 }]]);
  });

  it('never moves a thread read position backward', async () => {
    const slack = fakeSlack({ threadLastRead: '100.000009' });
    const res = await markRead(slack, { channel: 'C1', ts: '100.000004', thread_ts: '100.000001' });
    assert.equal(res.reason, 'already_read');
    assert.deepEqual(writes(slack), []);
  });

  it('does not mark when Slack reports no read position', async () => {
    const slack = fakeSlack({});
    const res = await markRead(slack, { channel: 'C1', ts: '100.000004' });
    assert.deepEqual(res, { marked: false, scope: 'channel', reason: 'last_read_unknown', last_read: null });
    assert.deepEqual(writes(slack), []);
  });
});
