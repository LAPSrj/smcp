// Tests for the shared Monitor command builder (src/listen-command.mjs).

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { STREAM_BINARY_PATH, buildMonitor, replyWatch } from '../src/listen-command.mjs';
import { parseArgs, passesFilters } from '../scripts/slack-listen-stream.mjs';

function flagsOf(command) {
  const prefix = `node ${STREAM_BINARY_PATH}`;
  assert.ok(command.startsWith(prefix), `unexpected command: ${command}`);
  const rest = command.slice(prefix.length).trim();
  return parseArgs(['node', STREAM_BINARY_PATH, ...(rest ? rest.split(' ') : [])]);
}

describe('buildMonitor', () => {
  it('points at the stream binary', () => {
    assert.ok(fs.existsSync(STREAM_BINARY_PATH), STREAM_BINARY_PATH);
  });

  it('has no flags by default', () => {
    assert.equal(buildMonitor().command, `node ${STREAM_BINARY_PATH}`);
  });

  it('bakes every filter into the command', () => {
    const flags = flagsOf(buildMonitor({
      watch_self: true, include_subtypes: true, channel: 'C1', thread: '111.000',
    }).command);
    assert.equal(flags.watchSelf, true);
    assert.equal(flags.includeSubtypes, true);
    assert.equal(flags.channel, 'C1');
    assert.equal(flags.thread, '111.000');
  });
});

describe('replyWatch', () => {
  const watch = replyWatch('C1');
  const flags = flagsOf(watch.monitor.command);

  it('filters on the channel only', () => {
    assert.equal(flags.channel, 'C1');
    assert.equal(flags.thread, null);
    assert.equal(watch.monitor.persistent, true);
  });

  it('delivers top-level replies', () => {
    assert.equal(passesFilters({ ts: '200.000', channel: 'C1', thread_ts: null }, flags), true);
  });

  it('delivers thread replies', () => {
    assert.equal(passesFilters({ ts: '201.000', channel: 'C1', thread_ts: '100.000' }, flags), true);
  });

  it('delivers replies with a file attached', () => {
    assert.equal(passesFilters({ ts: '203.000', channel: 'C1', thread_ts: null, subtype: 'file_share' }, flags), true);
  });

  it('drops messages from other channels', () => {
    assert.equal(passesFilters({ ts: '202.000', channel: 'C2', thread_ts: null }, flags), false);
  });
});
