import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { __testing, resolveTarget, resolveUserId, searchTargets } from '../src/resolver.mjs';

const { CACHE } = __testing;

function fakeSlack({ channels = [], users = [] } = {}) {
  const calls = [];
  const state = { channels, users };
  return {
    calls,
    state,
    auth: { test: async () => ({ user_id: 'USELF' }) },
    conversations: {
      list: async () => { calls.push('conversations.list'); return { channels: state.channels }; },
      open: async (p) => { calls.push('conversations.open'); return { channel: { id: `D_${p.users}` } }; },
    },
    users: {
      list: async () => { calls.push('users.list'); return { members: state.users }; },
      lookupByEmail: async ({ email }) => {
        const u = state.users.find((x) => x.profile?.email === email);
        if (!u) throw Object.assign(new Error('users_not_found'), { data: { error: 'users_not_found' } });
        return { user: u };
      },
    },
  };
}

const channel = (id, name, extra = {}) => ({ id, name, is_private: false, is_im: false, is_mpim: false, ...extra });
const user = (id, name, profile = {}) => ({ id, name, real_name: name, profile });

beforeEach(() => {
  CACHE.resolved.clear();
  CACHE.dms.clear();
  CACHE.userById.clear();
  CACHE.channels = null;
  CACHE.channelsAt = 0;
  CACHE.users = null;
  CACHE.usersAt = 0;
  CACHE.selfUserId = null;
});

describe('resolveTarget list refresh', () => {
  it('refetches the channel list when a name is missing and the list is over 30 s old', async () => {
    const slack = fakeSlack({ channels: [channel('C1', 'general')] });
    assert.equal((await resolveTarget(slack, '#general')).channel_id, 'C1');
    slack.state.channels = [channel('C1', 'general'), channel('C2', 'brand-new')];
    CACHE.channelsAt = Date.now() - 31_000;
    assert.equal((await resolveTarget(slack, '#brand-new')).channel_id, 'C2');
    assert.equal(slack.calls.filter((c) => c === 'conversations.list').length, 2);
  });

  it('does not refetch a list fetched under 30 s ago', async () => {
    const slack = fakeSlack({ channels: [channel('C1', 'general')] });
    await resolveTarget(slack, '#general');
    const res = await resolveTarget(slack, '#missing');
    assert.equal(res.error, 'no_match');
    assert.equal(slack.calls.filter((c) => c === 'conversations.list').length, 1);
  });

  it('refetches a list older than 10 minutes even when the name matches', async () => {
    const slack = fakeSlack({ channels: [channel('C1', 'general')] });
    await resolveTarget(slack, '#general');
    CACHE.resolved.clear();
    CACHE.channelsAt = Date.now() - 11 * 60_000;
    await resolveTarget(slack, '#general');
    assert.equal(slack.calls.filter((c) => c === 'conversations.list').length, 2);
  });
});

describe('archived channels', () => {
  const channels = [channel('C1', 'launch'), channel('C2', 'launch-old', { is_archived: true })];

  it('are skipped when resolving a send target', async () => {
    const res = await resolveTarget(fakeSlack({ channels }), '#launch-old');
    assert.equal(res.error, 'no_match');
  });

  it('are listed last by slack_resolve, marked is_archived', async () => {
    const { matches } = await searchTargets(fakeSlack({ channels }), '#launch');
    assert.deepEqual(matches.map((m) => [m.target_id, m.is_archived]), [['C1', false], ['C2', true]]);
  });
});

describe('searchTargets descriptions', () => {
  it('matches a channel topic or purpose after name matches', async () => {
    const slack = fakeSlack({
      channels: [
        channel('C1', 'website', { topic: { value: '' }, purpose: { value: '' } }),
        channel('C2', 'proj-x', { topic: { value: 'Website relaunch' }, purpose: { value: '' } }),
      ],
    });
    const { matches } = await searchTargets(slack, '#website');
    assert.deepEqual(matches.map((m) => m.target_id), ['C1', 'C2']);
    assert.equal(matches[1].topic, 'Website relaunch');
  });

  it('matches a person by job title', async () => {
    const slack = fakeSlack({ users: [user('U1', 'jack', { title: 'Project Manager' }), user('U2', 'ana', { title: 'Designer' })] });
    const { matches } = await searchTargets(slack, '@project manager');
    assert.deepEqual(matches.map((m) => [m.target_id, m.title]), [['U1', 'Project Manager']]);
  });

  it('does not match titles when resolving a send target', async () => {
    const slack = fakeSlack({ users: [user('U1', 'jack', { title: 'Designer' })] });
    assert.equal((await resolveTarget(slack, '@designer')).error, 'no_match');
  });
});

describe('resolveUserId', () => {
  const users = [user('U1', 'jack', { email: 'jack@example.com' }), user('U2', 'jackie'), user('U3', 'ana')];

  it('resolves @me, a user ID and an email without opening a DM', async () => {
    const slack = fakeSlack({ users });
    assert.deepEqual(await resolveUserId(slack, '@me'), { user_id: 'USELF' });
    assert.deepEqual(await resolveUserId(slack, 'U9ABCDEFG'), { user_id: 'U9ABCDEFG' });
    assert.deepEqual(await resolveUserId(slack, 'jack@example.com'), { user_id: 'U1' });
    assert.ok(!slack.calls.includes('conversations.open'));
  });

  it('takes a unique exact name over partial matches, and a single partial match', async () => {
    const slack = fakeSlack({ users });
    assert.deepEqual(await resolveUserId(slack, '@jack'), { user_id: 'U1' });
    assert.deepEqual(await resolveUserId(slack, 'an'), { user_id: 'U3' });
  });

  it('returns candidates when the name is ambiguous', async () => {
    const res = await resolveUserId(fakeSlack({ users }), 'jac');
    assert.equal(res.error, 'ambiguous');
    assert.deepEqual(res.candidates.map((c) => c.target_id), ['U1', 'U2']);
  });

  it('rejects a channel', async () => {
    assert.equal((await resolveUserId(fakeSlack(), '#general')).error, 'not_a_user');
    assert.equal((await resolveUserId(fakeSlack(), 'C0123456')).error, 'not_a_user');
  });
});
