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

// Returns { blocks } (empty when neither is given) or { error }. A form
// without buttons gets a Submit button, since only a click sends the values.
// The button row's block_id records whether the message takes one reply or
// one per person, so the listener can tell after a click.
export function buildControls({ buttons, form, replies } = {}) {
  if (replies !== undefined && replies !== 'single' && replies !== 'multiple') {
    return { error: `replies must be "single" or "multiple" (got ${JSON.stringify(replies)})` };
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

export function hasButtons(blocks = []) {
  return blocks.some((b) => b.type === 'actions' && (b.block_id === SINGLE || b.block_id === MULTIPLE));
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
