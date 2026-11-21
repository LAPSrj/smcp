import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { answeredBlocks, buildControls, formValues, isMultiple, isPoll, multipleReplyBlocks, pollAudience, pollBlocks, pollLayout, pollPicks, repliedNames, visibleTo } from '../src/controls.mjs';

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

describe('poll', () => {
  const text = { type: 'rich_text', elements: [] };
  const footer = { type: 'context', elements: [{ type: 'mrkdwn', text: '*Sent using* L.E.O' }] };
  const start = [text, ...buildControls({ buttons: [{ id: 'home', label: 'Home', style: 'danger' }, { id: 'office', label: 'Office' }], replies: 'poll' }).blocks, footer];
  const names = { U1: 'Ann Lee', U2: 'Bo Kim', U3: 'Cy Ode' };
  const pick = (blocks, userId, choice, audience) => pollBlocks(blocks, { userId, userName: names[userId], choice, audience });
  const own = (blocks, u) => blocks.find((b) => b.block_id?.startsWith(`poll:${u}|`));
  const tableRows = (blocks) => blocks.find((b) => b.type === 'data_table').rows.map((r) => r.map((c) => c.text));

  it('starts with "No replies yet" above plain buttons and needs buttons without a form', () => {
    assert.deepEqual(start.map((b) => b.block_id ?? b.type), ['rich_text', 'poll_empty', 'poll', 'context']);
    assert.match(buildControls({ buttons: [{ id: 'a', label: 'A' }], pollLayout: 'by_answer' }).error, /poll_layout/);
    assert.match(buildControls({ buttons: [{ id: 'a', label: 'A' }], replies: 'poll', pollLayout: 'grid' }).error, /poll_layout/);
    assert.equal(start[2].elements[0].style, undefined);
    assert.match(buildControls({ form: [{ id: 'n', label: 'N' }], buttons: [{ id: 'a', label: 'A' }], replies: 'poll' }).error, /no form/);
    assert.match(buildControls({ form: [{ id: 'n', label: 'N' }], replies: 'poll' }).error, /needs buttons/);
  });

  it('lists picks in a table, highlights each person\'s pick only for them and hides the shared row from them', () => {
    const one = pick(start, 'U2', 'office', ['U1', 'U2', 'U3']);
    assert.deepEqual(one.map((b) => b.block_id ?? b.type), ['rich_text', 'data_table', 'poll_counts', 'poll', 'poll:U2|Bo%20Kim|', 'context']);
    assert.deepEqual(tableRows(one), [['Name', 'Answer'], ['Bo Kim', 'Office']]);
    assert.deepEqual(pollAudience(one), ['U1', 'U3']);
    assert.deepEqual(own(one, 'U2').elements.map((e) => [e.action_id, e.style, e.visible_to_user_ids]), [['home', undefined, ['U2']], ['office', 'primary', ['U2']]]);
    const two = pick(one, 'U1', 'home', pollAudience(one));
    assert.deepEqual(tableRows(two), [['Name', 'Answer'], ['Ann Lee', 'Home'], ['Bo Kim', 'Office']]);
    assert.equal(two.find((b) => b.block_id === 'poll_counts').elements[0].text, 'Home: 1, Office: 1');
    assert.deepEqual([...pollPicks(two)], [['U2', { pick: 'office', name: 'Bo Kim', note: null }], ['U1', { pick: 'home', name: 'Ann Lee', note: null }]]);
  });

  it('lets a person change their pick, and keeps working after everyone picked', () => {
    let b = pick(start, 'U1', 'home', ['U1']);
    assert.equal(b.some((x) => x.block_id === 'poll'), false);
    assert.equal(isPoll(b), true);
    b = pick(b, 'U1', 'office', null);
    assert.deepEqual(tableRows(b), [['Name', 'Answer'], ['Ann Lee', 'Office']]);
    assert.equal(own(b, 'U1').elements.find((e) => e.style === 'primary').action_id, 'office');
  });

  it('highlights the first 10 people and leaves the rest on the shared row', () => {
    const ids = Array.from({ length: 11 }, (_, i) => `U${i + 10}`);
    let b = start;
    for (const id of ids) b = pollBlocks(b, { userId: id, userName: id, choice: 'home', audience: b === start ? ids : pollAudience(b) });
    assert.equal(b.filter((x) => x.block_id?.startsWith('poll:')).length, 10);
    assert.deepEqual(pollAudience(b), ['U20']);
    assert.equal(tableRows(b).length, 12);
  });

  it('saves each person\'s note with their pick and shows it in the table', () => {
    const noteStart = [text, ...buildControls({ buttons: [{ id: 'home', label: 'Home' }, { id: 'office', label: 'Office' }], replies: 'poll', pollNote: 'Note' }).blocks];
    assert.deepEqual(noteStart.map((b) => b.block_id ?? b.type), ['rich_text', 'poll_empty', 'poll_note', 'poll']);
    let b = pollBlocks(noteStart, { userId: 'U1', userName: 'Ann | Lee', choice: 'office', audience: null, note: 'in after lunch' });
    b = pollBlocks(b, { userId: 'U2', userName: 'Bo Kim', choice: 'home', audience: null, note: '  ' });
    assert.deepEqual(b.map((x) => x.block_id ?? x.type).slice(0, 5), ['rich_text', 'data_table', 'poll_counts', 'poll_note', 'poll']);
    assert.deepEqual(tableRows(b), [['Name', 'Answer', 'Note'], ['Bo Kim', 'Home', ' '], ['Ann | Lee', 'Office', 'in after lunch']]);
    assert.deepEqual(pollPicks(b).get('U1'), { pick: 'office', name: 'Ann | Lee', note: 'in after lunch' });
    b = pollBlocks(b, { userId: 'U1', userName: 'Ann | Lee', choice: 'office', audience: null, note: '' });
    assert.equal(pollPicks(b).get('U1').note, null);
    const long = pollBlocks(noteStart, { userId: 'U1', userName: 'Ann', choice: 'home', audience: null, note: 'é'.repeat(100) });
    assert.ok(long.every((x) => !x.block_id || x.block_id.length <= 255));
    assert.match(buildControls({ buttons: [{ id: 'a', label: 'A' }], pollNote: 'Note' }).error, /poll_note/);
  });

  it('by_answer puts one column per choice with the names under it, padding short columns', () => {
    const answerStart = [text, ...buildControls({ buttons: [{ id: 'home', label: 'Home' }, { id: 'office', label: 'Office' }], replies: 'poll', pollLayout: 'by_answer' }).blocks];
    assert.equal(pollLayout(answerStart), 'by_answer');
    let b = pick(answerStart, 'U1', 'office', null);
    b = pick(b, 'U2', 'office', null);
    b = pick(b, 'U3', 'home', null);
    assert.equal(pollLayout(b), 'by_answer');
    assert.deepEqual(tableRows(b), [['Home', 'Office'], ['Cy Ode', 'Ann Lee'], [' ', 'Bo Kim']]);
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
