import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { markdownToMrkdwn, messageBlocks, mrkdwnSections } from '../src/mrkdwn.mjs';

describe('markdownToMrkdwn', () => {
  it('converts inline formatting', () => {
    assert.equal(markdownToMrkdwn('**b** _i_ *i2* ~~s~~ `c`'), '*b* _i_ _i2_ ~s~ `c`');
  });

  it('converts links, autolinks and bare URLs', () => {
    assert.equal(
      markdownToMrkdwn('[t](https://u.com) and <https://x.com> and https://bare.com and a@b.com'),
      '<https://u.com|t> and <https://x.com> and <https://bare.com> and <mailto:a@b.com>',
    );
  });

  it('keeps Slack mentions and <url|text> links as they are', () => {
    const s = 'hi <@U123>, <#C123|general>, <!here>, <!subteam^S1> and <https://slack.com|link>';
    assert.equal(markdownToMrkdwn(s), s);
  });

  it('escapes &, < and > in text and code, but not an existing entity', () => {
    assert.equal(markdownToMrkdwn('a < b & c > d &amp; `x < 1`'), 'a &lt; b &amp; c &gt; d &amp; `x &lt; 1`');
    assert.equal(markdownToMrkdwn('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
  });

  it('converts headings, quotes, code blocks, rules and line breaks', () => {
    assert.equal(
      markdownToMrkdwn('# Title\n\n> one\n> **two**\n\n```js\nif (a < b) {}\n```\n\n---\n\nline  \nbreak'),
      '*Title*\n\n> one\n> *two*\n\n```\nif (a &lt; b) {}\n```\n\n---\n\nline\nbreak',
    );
  });

  it('converts lists, nested lists and task items', () => {
    assert.equal(markdownToMrkdwn('- a\n  - nested\n- b\n\n3. three\n4. four'), '• a\n  • nested\n• b\n\n3. three\n4. four');
    assert.equal(markdownToMrkdwn('- [x] done\n- [ ] todo'), '• [x] done\n• [ ] todo');
  });

  it('writes a table one row per line', () => {
    assert.equal(markdownToMrkdwn('| a | **b** |\n|---|---|\n| 1 | 2 |'), 'a | *b*\n1 | 2');
  });
});

describe('mrkdwnSections', () => {
  const texts = (s) => s.map((b) => b.text.text);

  it('keeps short text in one section', () => {
    assert.deepEqual(texts(mrkdwnSections('a\nb', 10)), ['a\nb']);
  });

  it('splits at the last line break within the limit and drops that break', () => {
    assert.deepEqual(texts(mrkdwnSections('aaaa\nbbbb\ncc', 10)), ['aaaa\nbbbb', 'cc']);
  });

  it('cuts a line longer than the limit', () => {
    assert.deepEqual(texts(mrkdwnSections('abcdefghij', 4)), ['abcd', 'efgh', 'ij']);
  });

  it('skips empty chunks', () => {
    assert.deepEqual(texts(mrkdwnSections('abcd\n', 4)), ['abcd']);
  });
});

describe('messageBlocks', () => {
  const footer = '*Sent using* L.E.O';
  const context = { type: 'context', elements: [{ type: 'mrkdwn', text: footer }] };

  it('sends Markdown as a markdown block, with mrkdwn text for notifications', () => {
    assert.deepEqual(messageBlocks('**hi** [x](https://x.com)', { footer, markdown: true }), {
      text: '*hi* <https://x.com|x>\n*Sent using* L.E.O',
      blocks: [{ type: 'markdown', text: '**hi** [x](https://x.com)' }, context],
    });
  });

  it('sends mrkdwn as section blocks, with the same text for notifications', () => {
    assert.deepEqual(messageBlocks('*hi*', { footer, markdown: false }), {
      text: '*hi*\n*Sent using* L.E.O',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*hi*' } }, context],
    });
  });

  it('puts controls between the text and the footer, and leaves the footer out when there is none', () => {
    const actions = { type: 'actions', elements: [] };
    assert.deepEqual(messageBlocks('**hi**', { markdown: true, controls: [actions] }), {
      text: '*hi*',
      blocks: [{ type: 'markdown', text: '**hi**' }, actions],
    });
    assert.deepEqual(messageBlocks('**hi**', { markdown: true, footer, controls: [actions] }).blocks, [
      { type: 'markdown', text: '**hi**' }, actions, context,
    ]);
  });
});
