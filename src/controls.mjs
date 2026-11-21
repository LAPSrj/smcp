// Buttons and form fields for slack_send, as Block Kit blocks, and the values
// a click sends back. A click on any button carries every field's value.

const MAX_BUTTONS = 25;
const MAX_FIELDS = 40;
const MAX_OPTIONS = 100;
const LABEL_MAX = 75;
const ID_MAX = 255;
const VALUE_MAX = 2000;

const CHOICE_TYPES = new Set(['select', 'multi_select', 'checkboxes', 'radio']);
const MULTI_TYPES = new Set(['multi_select', 'checkboxes']);
const FIELD_TYPES = ['text', 'multiline', 'number', 'select', 'multi_select', 'checkboxes', 'radio', 'date', 'time', 'user', 'channel'];
const NO_PLACEHOLDER = new Set(['checkboxes', 'radio']);

export const DEFAULT_SUBMIT = { id: 'submit', label: 'Submit', style: 'primary' };

const plain = (text) => ({ type: 'plain_text', text });
const option = (v) => ({ text: plain(v), value: v });

function isText(v, max) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function buttonBlock(b) {
  const el = { type: 'button', action_id: b.id, text: plain(b.label) };
  if (b.style) el.style = b.style;
  if (b.value !== undefined) el.value = b.value;
  return el;
}

function checkButton(b, i) {
  const at = `buttons[${i}]`;
  if (!b || typeof b !== 'object') return `${at} must be an object with id and label`;
  if (!isText(b.id, ID_MAX)) return `${at}.id must be a non-empty string of at most ${ID_MAX} characters`;
  if (!isText(b.label, LABEL_MAX)) return `${at}.label must be a non-empty string of at most ${LABEL_MAX} characters`;
  if (b.style !== undefined && b.style !== 'primary' && b.style !== 'danger') return `${at}.style must be "primary" or "danger"`;
  if (b.value !== undefined && (typeof b.value !== 'string' || b.value.length > VALUE_MAX)) return `${at}.value must be a string of at most ${VALUE_MAX} characters`;
  return null;
}

function checkField(f, i) {
  const at = `form[${i}]`;
  if (!f || typeof f !== 'object') return `${at} must be an object with id and label`;
  if (!isText(f.id, ID_MAX)) return `${at}.id must be a non-empty string of at most ${ID_MAX} characters`;
  if (!isText(f.label, 2000)) return `${at}.label must be a non-empty string`;
  const type = f.type ?? 'text';
  if (!FIELD_TYPES.includes(type)) return `${at}.type must be one of ${FIELD_TYPES.join(', ')} (got ${JSON.stringify(f.type)})`;
  if (CHOICE_TYPES.has(type)) {
    const opts = f.options;
    if (!Array.isArray(opts) || opts.length === 0 || opts.length > MAX_OPTIONS) return `${at}.options must list 1-${MAX_OPTIONS} choices for type "${type}"`;
    if (!opts.every((o) => isText(o, LABEL_MAX))) return `${at}.options must be non-empty strings of at most ${LABEL_MAX} characters`;
    if (new Set(opts).size !== opts.length) return `${at}.options has a choice twice`;
    const initial = f.initial === undefined ? [] : MULTI_TYPES.has(type) ? f.initial : [f.initial];
    if (!Array.isArray(initial) || !initial.every((v) => opts.includes(v))) {
      return `${at}.initial must be ${MULTI_TYPES.has(type) ? 'a list of choices' : 'one choice'} from options`;
    }
  } else if (f.options !== undefined) {
    return `${at}.options only applies to select, multi_select, checkboxes and radio`;
  } else if (f.initial !== undefined && typeof f.initial !== 'string') {
    return `${at}.initial must be a string for type "${type}"`;
  }
  if (f.placeholder !== undefined && (NO_PLACEHOLDER.has(type) || !isText(f.placeholder, 150))) {
    return `${at}.placeholder must be a string of at most 150 characters, and checkboxes and radio don't take one`;
  }
  return null;
}

function fieldElement(f) {
  const type = f.type ?? 'text';
  const el = { action_id: f.id };
  const init = f.initial;
  switch (type) {
    case 'text':
    case 'multiline':
      Object.assign(el, { type: 'plain_text_input', multiline: type === 'multiline' });
      if (init !== undefined) el.initial_value = init;
      break;
    case 'number':
      Object.assign(el, { type: 'number_input', is_decimal_allowed: true });
      if (init !== undefined) el.initial_value = init;
      break;
    case 'select':
    case 'radio':
      Object.assign(el, { type: type === 'select' ? 'static_select' : 'radio_buttons', options: f.options.map(option) });
      if (init !== undefined) el.initial_option = option(init);
      break;
    case 'multi_select':
    case 'checkboxes':
      Object.assign(el, { type: type === 'multi_select' ? 'multi_static_select' : 'checkboxes', options: f.options.map(option) });
      if (init?.length) el.initial_options = init.map(option);
      break;
    case 'date':
      el.type = 'datepicker';
      if (init !== undefined) el.initial_date = init;
      break;
    case 'time':
      el.type = 'timepicker';
      if (init !== undefined) el.initial_time = init;
      break;
    case 'user':
      el.type = 'users_select';
      if (init !== undefined) el.initial_user = init;
      break;
    case 'channel':
      el.type = 'conversations_select';
      if (init !== undefined) el.initial_conversation = init;
      break;
  }
  if (f.placeholder !== undefined) el.placeholder = plain(f.placeholder);
  return el;
}

export const SINGLE = 'buttons';
export const MULTIPLE = 'buttons:multiple';
export const POLL = 'poll';
const POLL_PICK = 'poll:';
const POLL_EMPTY = 'poll_empty';
const POLL_COUNTS = 'poll_counts';
const POLL_NOTE = 'poll_note';
const NOTE_MAX = 100;
// Each person's highlighted buttons are a row only they see, and Slack leaves
// about 8 px of blank space for every row a viewer can't see. People past this
// many keep the shared, unhighlighted row, which keeps that space under 80 px.
const MAX_HIGHLIGHTED = 10;

// Returns { blocks } (empty when neither is given) or { error }. A form
// without buttons gets a Submit button, since only a click sends the values.
// The button row's block_id records whether the message takes one reply or
// one per person, so the listener can tell after a click.
export const POLL_LAYOUTS = ['by_person', 'by_answer'];

export function buildControls({ buttons, form, replies, pollLayout, pollNote } = {}) {
  if (pollLayout !== undefined && (replies !== 'poll' || !POLL_LAYOUTS.includes(pollLayout))) {
    return { error: 'poll_layout must be "by_person" or "by_answer", with replies "poll"' };
  }
  if (pollNote !== undefined && (replies !== 'poll' || !isText(pollNote, 2000))) {
    return { error: 'poll_note must be the note field\'s label, with replies "poll"' };
  }
  if (replies !== undefined && !['single', 'multiple', 'poll'].includes(replies)) {
    return { error: `replies must be "single", "multiple" or "poll" (got ${JSON.stringify(replies)})` };
  }
  if (replies === 'poll' && (form !== undefined || buttons === undefined)) {
    return { error: 'replies "poll" needs buttons (one per choice) and no form' };
  }
  if (buttons === undefined && form === undefined) {
    return replies === undefined ? { blocks: [] } : { error: 'replies needs buttons or form' };
  }
  if (buttons !== undefined && (!Array.isArray(buttons) || buttons.length === 0 || buttons.length > MAX_BUTTONS)) {
    return { error: `buttons must list 1-${MAX_BUTTONS} buttons` };
  }
  if (form !== undefined && (!Array.isArray(form) || form.length === 0 || form.length > MAX_FIELDS)) {
    return { error: `form must list 1-${MAX_FIELDS} fields` };
  }
  const fields = form ?? [];
  const btns = buttons ?? [DEFAULT_SUBMIT];
  for (const [i, b] of btns.entries()) {
    const err = checkButton(b, i);
    if (err) return { error: err };
  }
  for (const [i, f] of fields.entries()) {
    const err = checkField(f, i);
    if (err) return { error: err };
  }
  const ids = [...fields.map((f) => f.id), ...btns.map((b) => b.id)];
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) {
    const hint = buttons === undefined && dup === DEFAULT_SUBMIT.id ? ' (the default Submit button uses it; rename the field or pass buttons)' : '';
    return { error: `id "${dup}" is used twice; every button and field needs its own id${hint}` };
  }
  if (replies === 'poll') {
    return {
      blocks: [
        { type: 'context', block_id: POLL_EMPTY + (pollLayout === 'by_answer' ? ':by_answer' : ''), elements: [{ type: 'mrkdwn', text: 'No replies yet' }] },
        ...(pollNote === undefined ? [] : [{
          type: 'input',
          block_id: POLL_NOTE,
          optional: true,
          label: plain(pollNote),
          element: { type: 'plain_text_input', action_id: POLL_NOTE, max_length: NOTE_MAX },
        }]),
        { type: 'actions', block_id: POLL, elements: btns.map((b) => buttonBlock({ ...b, style: undefined })) },
      ],
    };
  }
  return {
    blocks: [
      ...fields.map((f) => ({
        type: 'input',
        block_id: `field:${f.id}`,
        label: plain(f.label),
        // Slack doesn't check required fields in messages, so every field is
        // optional and the agent checks the values the click reports.
        optional: true,
        element: fieldElement(f),
      })),
      { type: 'actions', block_id: replies === 'multiple' ? MULTIPLE : SINGLE, elements: btns.map(buttonBlock) },
    ],
  };
}

function elementValue(v = {}) {
  switch (v.type) {
    case 'static_select':
    case 'radio_buttons':
      return v.selected_option?.value ?? null;
    case 'multi_static_select':
    case 'checkboxes':
      return (v.selected_options ?? []).map((o) => o.value);
    case 'datepicker':
      return v.selected_date ?? null;
    case 'timepicker':
      return v.selected_time ?? null;
    case 'users_select':
      return v.selected_user ?? null;
    case 'conversations_select':
      return v.selected_conversation ?? null;
    default:
      return v.value ?? null;
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ANSWER_MAX = 2900;

function answerText(v, names) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) return '_(empty)_';
  const text = (Array.isArray(v) ? v : [v]).map((x) => names[x] ?? x).join(', ');
  return esc(text.length > ANSWER_MAX ? `${text.slice(0, ANSWER_MAX)}…` : text);
}

// The message after a click: each field shows its answer as text, and the
// button row goes away. In a group conversation a line says who replied. A
// row of several buttons also says which one was clicked, since the row is gone.
// names maps user and channel IDs in the answers to "@name" and "#name".
export function answeredBlocks(blocks, { values, clicked, repliedBy = null, names = {} }) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'input' && b.block_id?.startsWith('field:')) {
      const id = b.element?.action_id;
      out.push({ type: 'section', text: { type: 'mrkdwn', text: `*${esc(b.label?.text ?? id)}*\n${answerText(values[id], names)}` } });
    } else if (b.type === 'actions' && b.block_id === SINGLE) {
      const choice = (b.elements?.length ?? 0) > 1 ? clicked : null;
      let line = null;
      if (repliedBy) line = choice ? `Replied by ${esc(repliedBy)}: ${esc(choice)}` : `Replied by ${esc(repliedBy)}`;
      else if (choice) line = `Selected: ${esc(choice)}`;
      if (line) out.push({ type: 'context', elements: [{ type: 'mrkdwn', text: line }] });
    } else {
      out.push(b);
    }
  }
  return out;
}

const REPLIED_PREFIX = 'Replied by ';

export function isMultiple(blocks = []) {
  return blocks.some((b) => b.type === 'actions' && b.block_id === MULTIPLE);
}

const isPollRow = (b) => b.type === 'actions' && (b.block_id === POLL || b.block_id?.startsWith(POLL_PICK));

export function hasButtons(blocks = []) {
  return blocks.some((b) => b.type === 'actions' && [SINGLE, MULTIPLE].includes(b.block_id)) || isPoll(blocks);
}

// The shared row goes away once everyone picked, so a person's own row counts too.
export function isPoll(blocks = []) {
  return blocks.some(isPollRow);
}

// Each person's pick, from the button rows only they see, as user ID →
// { pick, name, note }. A row's block_id is "poll:<user ID>|<name>|<note>",
// name and note URI-encoded, so the message holds everyone's name and note
// and the listener doesn't look anyone up again.
export function pollPicks(blocks = []) {
  const picks = new Map();
  for (const b of blocks) {
    if (b.type !== 'actions' || !b.block_id?.startsWith(POLL_PICK)) continue;
    const pick = b.elements?.find((e) => e.style === 'primary')?.action_id;
    const [id, name = '', note = ''] = b.block_id.slice(POLL_PICK.length).split('|');
    if (pick) picks.set(id, { pick, name: decodeURIComponent(name) || id, note: decodeURIComponent(note) || null });
  }
  return picks;
}

// block_id is capped at 255 characters, so a long note is cut to fit.
function pickBlockId(id, { name, note }) {
  const head = `${POLL_PICK}${id}|${encodeURIComponent(name.slice(0, 80))}|`;
  let text = note ?? '';
  while (text && (head + encodeURIComponent(text)).length > 255) text = text.slice(0, -1);
  return head + encodeURIComponent(text);
}

const isPollMarker = (b) => b.type === 'context' && (b.block_id?.startsWith(POLL_EMPTY) || b.block_id?.startsWith(POLL_COUNTS));

export function pollLayout(blocks = []) {
  return blocks.find(isPollMarker)?.block_id.endsWith(':by_answer') ? 'by_answer' : 'by_person';
}

// The IDs the shared row shows to, or null before anyone picked.
export function pollAudience(blocks = []) {
  const ids = blocks.find((b) => b.type === 'actions' && b.block_id === POLL)?.elements?.[0]?.visible_to_user_ids;
  return Array.isArray(ids) ? ids : null;
}

const cell = (text) => ({ type: 'raw_text', text });

// The poll after someone picks. A table lists everyone's pick: one row per
// person (by_person) or one column per choice with the names under it
// (by_answer), with the count per choice under it. Each person who picked
// gets their own copy of the buttons with their pick highlighted, and the
// shared row shows only to the rest of audience (the conversation's members;
// null shows it to everyone).
export function pollBlocks(blocks, { userId, userName, choice, audience, note = null }) {
  const shared = { type: 'actions', block_id: POLL };
  const template = blocks.find(isPollRow).elements.map(({ visible_to_user_ids, style, ...e }) => e);
  const labels = new Map(template.map((e) => [e.action_id, e.text?.text ?? e.action_id]));
  const layout = pollLayout(blocks);
  const suffix = layout === 'by_answer' ? ':by_answer' : '';
  const picks = pollPicks(blocks);
  picks.delete(userId);
  const highlighted = [...picks.keys()];
  if (highlighted.length < MAX_HIGHLIGHTED) highlighted.push(userId);
  picks.set(userId, { pick: choice, name: userName ?? userId, note: note?.trim() || null });
  const noteField = blocks.find((b) => b.type === 'input' && b.block_id === POLL_NOTE);

  const order = template.map((e) => e.action_id);
  const rows = [...picks.values()].sort((a, b) => order.indexOf(a.pick) - order.indexOf(b.pick) || a.name.localeCompare(b.name));
  const byChoice = order.map((id) => rows.filter((r) => r.pick === id).map((r) => (r.note ? `${r.name} (${r.note})` : r.name)));
  const tallest = Math.max(...byChoice.map((names) => names.length));
  const table = {
    type: 'data_table',
    caption: 'Replies',
    page_size: 20,
    rows: layout === 'by_answer'
      // A cell can't be empty, so a shorter column is padded with a space.
      ? [order.map((id) => cell(labels.get(id))), ...Array.from({ length: tallest }, (_, i) => byChoice.map((names) => cell(names[i] ?? ' ')))]
      : noteField
        ? [[cell('Name'), cell('Answer'), cell(noteField.label?.text ?? 'Note')], ...rows.map((r) => [cell(r.name), cell(labels.get(r.pick) ?? r.pick), cell(r.note ?? ' ')])]
        : [[cell('Name'), cell('Answer')], ...rows.map((r) => [cell(r.name), cell(labels.get(r.pick) ?? r.pick)])],
  };
  const counts = order
    .map((id) => [labels.get(id), rows.filter((r) => r.pick === id).length])
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${esc(label)}: ${n}`)
    .join(', ');
  const rest = audience === null ? null : audience.filter((id) => !highlighted.includes(id));
  const sharedRow = rest === null ? { ...shared, elements: template }
    : rest.length > 0 ? { ...shared, elements: template.map((e) => ({ ...e, visible_to_user_ids: rest })) }
    : null;
  const own = highlighted.map((u) => ({
    type: 'actions',
    block_id: pickBlockId(u, picks.get(u)),
    elements: template.map((e) => ({ ...e, ...(e.action_id === picks.get(u).pick && { style: 'primary' }), visible_to_user_ids: [u] })),
  }));
  const pollPart = [
    table,
    { type: 'context', block_id: POLL_COUNTS + suffix, elements: [{ type: 'mrkdwn', text: counts }] },
    ...(noteField ? [noteField] : []),
    ...(sharedRow ? [sharedRow] : []),
    ...own,
  ];

  const isPollBlock = (b) => b.type === 'data_table' || isPollMarker(b) || isPollRow(b) || b.block_id === POLL_NOTE;
  const start = blocks.findIndex(isPollBlock);
  return [...blocks.slice(0, start), ...pollPart, ...blocks.filter((b, i) => i > start && !isPollBlock(b))];
}

// The people already named in the "Replied by" line, as written there.
export function repliedNames(blocks = []) {
  const line = blocks.find((b) => b.type === 'context' && b.block_id === 'replied')?.elements?.[0]?.text ?? '';
  return line.startsWith(REPLIED_PREFIX) ? line.slice(REPLIED_PREFIX.length).split(', ').filter(Boolean) : [];
}

// The IDs the buttons still show to, or null before anyone replied.
export function visibleTo(blocks = []) {
  const ids = blocks.find((b) => b.type === 'actions' && b.block_id === MULTIPLE)?.elements?.[0]?.visible_to_user_ids;
  return Array.isArray(ids) ? ids : null;
}

// A message that takes one reply per person keeps its fields and buttons after
// a click. The buttons show only to the people in visible (everyone else in
// the conversation, minus those who replied), and a line under them names who
// replied. visible null keeps them showing to everyone, for a conversation
// whose members couldn't be listed.
export function multipleReplyBlocks(blocks, { replier, visible }) {
  const names = [...repliedNames(blocks), esc(replier)];
  const out = [];
  for (const b of blocks) {
    if (b.type === 'context' && b.block_id === 'replied') continue;
    if (b.type === 'actions' && b.block_id === MULTIPLE) {
      if (visible === null) out.push(b);
      else if (visible.length > 0) out.push({ ...b, elements: b.elements.map((e) => ({ ...e, visible_to_user_ids: visible })) });
      out.push({ type: 'context', block_id: 'replied', elements: [{ type: 'mrkdwn', text: REPLIED_PREFIX + names.join(', ') }] });
      continue;
    }
    out.push(b);
  }
  return out;
}

// state.values of a block_actions payload, as { field id: value }.
export function formValues(stateValues) {
  const out = {};
  for (const block of Object.values(stateValues ?? {})) {
    for (const [id, v] of Object.entries(block ?? {})) out[id] = elementValue(v);
  }
  return out;
}
