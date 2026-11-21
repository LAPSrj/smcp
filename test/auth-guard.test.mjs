import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';

import { buildPhrase, encodeCwdForClaudeProject, extractUserTypedText, resolveTranscriptDir, verifyAuthorization } from '../src/auth-guard.mjs';

const typed = (text) => ({ type: 'user', promptSource: 'typed', message: { role: 'user', content: text } });
const human = (text) => ({ type: 'user', origin: { kind: 'human' }, message: { content: [{ type: 'text', text }] } });

describe('encodeCwdForClaudeProject', () => {
  it('turns every character other than a letter or digit into a dash', () => {
    assert.equal(encodeCwdForClaudeProject('/home/me/repos/smcp'), '-home-me-repos-smcp');
    assert.equal(encodeCwdForClaudeProject('/home/me/work/.tmp'), '-home-me-work--tmp');
    assert.equal(encodeCwdForClaudeProject('/home/me/my_repo.v2'), '-home-me-my-repo-v2');
  });
});

describe('resolveTranscriptDir', () => {
  it('prefers SLACK_TRANSCRIPT_DIR, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
    assert.equal(resolveTranscriptDir('/w', { SLACK_TRANSCRIPT_DIR: '/t', CLAUDE_CONFIG_DIR: '/c' }), '/t');
    assert.equal(resolveTranscriptDir('/w', { CLAUDE_CONFIG_DIR: '/c', HOME: '/h' }), '/c/projects/-w');
    assert.equal(resolveTranscriptDir('/w', { HOME: '/h' }), '/h/.claude/projects/-w');
  });
});

describe('extractUserTypedText', () => {
  it('accepts typed prompts and human-origin messages', () => {
    assert.equal(extractUserTypedText(typed('hi')), 'hi');
    assert.equal(extractUserTypedText(human('hello')), 'hello');
  });

  it('accepts a message queued while the agent works', () => {
    const rec = { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'queued' } };
    assert.equal(extractUserTypedText(rec), 'queued');
  });

  it('rejects tool results, meta injections, notifications and assistant text', () => {
    assert.equal(extractUserTypedText({ type: 'user', promptSource: 'typed', message: { content: [{ type: 'tool_result', content: 'x' }] } }), null);
    assert.equal(extractUserTypedText({ ...typed('x'), isMeta: true }), null);
    assert.equal(extractUserTypedText({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'x' } }), null);
    assert.equal(extractUserTypedText({ type: 'user', message: { content: 'no source tag' } }), null);
    assert.equal(extractUserTypedText({ type: 'assistant', message: { content: 'x' } }), null);
  });
});

describe('verifyAuthorization', () => {
  let dir;
  const phrase = buildPhrase('delete', 'message 1795000000.000100 in #general');
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smcp-guard-'));
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'text', text: phrase }] } },
      { type: 'user', origin: { kind: 'peer' }, message: { content: phrase } },
      typed(`ok: "${phrase.toUpperCase()}"`),
    ];
    fs.writeFileSync(path.join(dir, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"partial');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('authorizes when the user typed the sentence, ignoring case and quotes', () => {
    assert.equal(verifyAuthorization('delete', 'message 1795000000.000100 in #general', { transcriptDir: dir }).authorized, true);
  });

  it("doesn't count the sentence when only the agent or another session wrote it", () => {
    fs.writeFileSync(path.join(dir, 's1.jsonl'), [
      { type: 'assistant', message: { content: [{ type: 'text', text: phrase }] } },
      { type: 'user', origin: { kind: 'peer' }, message: { content: phrase } },
    ].map((l) => JSON.stringify(l)).join('\n'));
    const r = verifyAuthorization('delete', 'message 1795000000.000100 in #general', { transcriptDir: dir });
    assert.equal(r.authorized, false);
    assert.equal(r.requiredPhrase, phrase);
  });

  it('needs the exact resource', () => {
    fs.writeFileSync(path.join(dir, 's1.jsonl'), JSON.stringify(typed(phrase)));
    assert.equal(verifyAuthorization('delete', 'message 1795000000.000101 in #general', { transcriptDir: dir }).authorized, false);
  });

  it('fails closed without a transcript folder', () => {
    const r = verifyAuthorization('delete', 'x', { transcriptDir: path.join(dir, 'missing') });
    assert.equal(r.authorized, false);
    assert.match(r.reason, /No Claude Code transcript folder/);
  });
});
