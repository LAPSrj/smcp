import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { answeredBlocks, buildControls, formValues, isMultiple, multipleReplyBlocks, repliedNames, visibleTo } from '../src/controls.mjs';

describe('buildControls', () => {
  it('returns no blocks without buttons or form', () => {
    assert.deepEqual(buildControls({}), { blocks: [] });
  });

  it('builds one actions block from buttons', () => {
    const { blocks } = buildControls({ buttons: [{ id: 'yes', label: 'Approve', style: 'primary', value: 'v1' }, { id: 'no', label: 'Reject' }] });
    assert.deepEqual(blocks, [{
      type: 'actions',
      block_id: 'buttons',
      elements: [
        { type: 'button', action_id: 'yes', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', value: 'v1' },
        { type: 'button', action_id: 'no', text: { type: 'plain_text', text: 'Reject' } },
      ],
    }]);
  });

  it('adds a Submit button to a form without buttons', () => {
    const { blocks } = buildControls({ form: [{ id: 'note', label: 'Note' }] });
    assert.deepEqual(blocks[0], {
      type: 'input',
      block_id: 'field:note',
      label: { type: 'plain_text', text: 'Note' },
      optional: true,
      element: { action_id: 'note', type: 'plain_text_input', multiline: false },
    });
    assert.deepEqual(blocks[1].elements.map((e) => [e.action_id, e.text.text, e.style]), [['submit', 'Submit', 'primary']]);
  });

  it('maps each field type to its element, with initial values and placeholders', () => {
    const { blocks } = buildControls({
      buttons: [{ id: 'go', label: 'Go' }],
      form: [
        { id: 'a', label: 'A', type: 'multiline', initial: 'x', placeholder: 'p' },
        { id: 'b', label: 'B', type: 'select', options: ['s', 'p'], initial: 'p' },
        { id: 'c', label: 'C', type: 'checkboxes', options: ['1', '2'], initial: ['2'] },
        { id: 'd', label: 'D', type: 'date', initial: '2026-11-21' },
        { id: 'e', label: 'E', type: 'number' },
        { id: 'f', label: 'F', type: 'user' },
      ],
    });
    const els = blocks.slice(0, -1).map((b) => b.element);
    assert.deepEqual(els[0], { action_id: 'a', type: 'plain_text_input', multiline: true, initial_value: 'x', placeholder: { type: 'plain_text', text: 'p' } });
    assert.equal(els[1].type, 'static_select');
    assert.deepEqual(els[1].initial_option, { text: { type: 'plain_text', text: 'p' }, value: 'p' });
    assert.equal(els[2].type, 'checkboxes');
    assert.deepEqual(els[2].initial_options.map((o) => o.value), ['2']);
    assert.deepEqual(els[3], { action_id: 'd', type: 'datepicker', initial_date: '2026-11-21' });
    assert.deepEqual(els[4], { action_id: 'e', type: 'number_input', is_decimal_allowed: true });
    assert.deepEqual(els[5], { action_id: 'f', type: 'users_select' });
  });

  it('rejects bad input with a message naming the field', () => {
    assert.match(buildControls({ buttons: [] }).error, /1-25 buttons/);
    assert.match(buildControls({ buttons: [{ id: 'x' }] }).error, /buttons\[0\]\.label/);
    assert.match(buildControls({ buttons: [{ id: 'x', label: 'X', style: 'blue' }] }).error, /style/);
    assert.match(buildControls({ form: [{ id: 'x', label: 'X', type: 'slider' }] }).error, /form\[0\]\.type/);
    assert.match(buildControls({ form: [{ id: 'x', label: 'X', type: 'select' }] }).error, /options/);
    assert.match(buildControls({ form: [{ id: 'x', label: 'X', type: 'select', options: ['a'], initial: 'b' }] }).error, /initial/);
    assert.match(buildControls({ form: [{ id: 'x', label: 'X', options: ['a'] }] }).error, /only applies/);
    assert.match(buildControls({ form: [{ id: 'x', label: 'X', type: 'radio', options: ['a'], placeholder: 'p' }] }).error, /placeholder/);
    assert.match(buildControls({ form: [{ id: 'x', label: 'X' }], buttons: [{ id: 'x', label: 'Go' }] }).error, /"x" is used twice/);
    assert.match(buildControls({ form: [{ id: 'submit', label: 'X' }] }).error, /default Submit button/);
  });
});

describe('answeredBlocks', () => {
  const text = { type: 'rich_text', elements: [] };
  const footer = { type: 'context', elements: [{ type: 'mrkdwn', text: '*Sent using* L.E.O' }] };
  const form = buildControls({
    form: [{ id: 'note', label: 'Notes' }, { id: 'who', label: 'Owner', type: 'user' }, { id: 'tags', label: 'Tags', type: 'checkboxes', options: ['a', 'b'] }],
  }).blocks;
  const twoButtons = buildControls({ buttons: [{ id: 'yes', label: 'Approve' }, { id: 'no', label: 'Reject' }] }).blocks;

  it('shows each answer as text and removes a single button in a DM', () => {
    const out = answeredBlocks([text, ...form, footer], { values: { note: 'a <b> & c', who: 'U1', tags: [] }, clicked: 'Submit', names: { U1: 'Alice Example' } });
    assert.deepEqual(out, [
      text,
      { type: 'section', text: { type: 'mrkdwn', text: '*Notes*\na &lt;b&gt; &amp; c' } },
      { type: 'section', text: { type: 'mrkdwn', text: '*Owner*\nAlice Example' } },
      { type: 'section', text: { type: 'mrkdwn', text: '*Tags*\n_(empty)_' } },
      footer,
    ]);
  });

  it('says which of several buttons was clicked, and who replied in a group conversation', () => {
    const line = (o) => o.find((b) => b.type === 'context').elements[0].text;
    assert.equal(line(answeredBlocks(twoButtons, { values: {}, clicked: 'Approve' })), 'Selected: Approve');
    assert.equal(line(answeredBlocks(twoButtons, { values: {}, clicked: 'Approve', repliedBy: 'Sam Lee' })), 'Replied by Sam Lee: Approve');
    assert.equal(line(answeredBlocks(form.slice(-1), { values: {}, clicked: 'Submit', repliedBy: 'Sam Lee' })), 'Replied by Sam Lee');
  });
});

describe('multiple replies', () => {
  const text = { type: 'rich_text', elements: [] };
  const footer = { type: 'context', elements: [{ type: 'mrkdwn', text: '*Sent using* L.E.O' }] };
  const controls = buildControls({ form: [{ id: 'note', label: 'Notes' }], replies: 'multiple' }).blocks;

  it('marks the button row and checks the option', () => {
    assert.equal(controls.at(-1).block_id, 'buttons:multiple');
    assert.equal(isMultiple(controls), true);
    assert.equal(buildControls({ form: [{ id: 'n', label: 'N' }] }).blocks.at(-1).block_id, 'buttons');
    assert.match(buildControls({ form: [{ id: 'n', label: 'N' }], replies: 'all' }).error, /replies/);
    assert.match(buildControls({ replies: 'multiple' }).error, /needs buttons or form/);
  });

  it('keeps the fields, hides the buttons from people who replied and lists them', () => {
    const first = multipleReplyBlocks([text, ...controls, footer], { replier: 'Ann Lee', visible: ['U2', 'U3'] });
    assert.deepEqual(first.map((b) => b.type), ['rich_text', 'input', 'actions', 'context', 'context']);
    assert.deepEqual(visibleTo(first), ['U2', 'U3']);
    assert.deepEqual(repliedNames(first), ['Ann Lee']);
    const second = multipleReplyBlocks(first, { replier: 'Bo <Q>', visible: ['U3'] });
    assert.deepEqual(visibleTo(second), ['U3']);
    assert.deepEqual(repliedNames(second), ['Ann Lee', 'Bo &lt;Q&gt;']);
    assert.equal(second.filter((b) => b.block_id === 'replied').length, 1);
  });

  it('drops the buttons once everyone replied, and keeps them for everyone when members are unknown', () => {
    assert.equal(multipleReplyBlocks(controls, { replier: 'Ann', visible: [] }).some((b) => b.type === 'actions'), false);
    assert.equal(visibleTo(multipleReplyBlocks(controls, { replier: 'Ann', visible: null })), null);
  });
});

describe('formValues', () => {
  it('reads each element type as a plain value keyed by field id', () => {
    assert.deepEqual(formValues({
      'field:a': { a: { type: 'plain_text_input', value: 'hi' } },
      'field:b': { b: { type: 'static_select', selected_option: { value: 'prod' } } },
      'field:c': { c: { type: 'checkboxes', selected_options: [{ value: '1' }, { value: '2' }] } },
      'field:d': { d: { type: 'datepicker', selected_date: '2026-11-21' } },
      'field:e': { e: { type: 'timepicker', selected_time: '09:30' } },
      'field:f': { f: { type: 'users_select', selected_user: 'U1' } },
      'field:g': { g: { type: 'conversations_select', selected_conversation: 'C1' } },
      'field:h': { h: { type: 'radio_buttons', selected_option: null } },
      'field:i': { i: { type: 'number_input', value: '3.5' } },
    }), { a: 'hi', b: 'prod', c: ['1', '2'], d: '2026-11-21', e: '09:30', f: 'U1', g: 'C1', h: null, i: '3.5' });
  });

  it('returns an empty object without state', () => {
    assert.deepEqual(formValues(undefined), {});
  });
});
