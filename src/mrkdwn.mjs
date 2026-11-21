// Markdown to Slack mrkdwn, for the text Slack shows in notifications and
// screen readers when a message is sent as blocks.

import { Lexer } from 'marked';

const SECTION_MAX = 3000;

// Slack's own control sequences: mentions (<@U…>, <#C…|name>, <!here>) and
// links (<url> or <url|text>), kept as they are.
const SLACK_SEQUENCE = /<(?:[@#!][^<>\s][^<>]*|(?:https?|mailto):[^<>\s]+)>/g;

// Escapes text the way Slack requires (&, <, >), leaving an & that already
// starts an entity alone, as marked's own escape does.
function escapeText(s) {
  return s.replace(/&(?!#\d{1,7};|#[Xx][a-fA-F0-9]{1,6};|\w+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeKeepingSequences(s) {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(SLACK_SEQUENCE)) {
    out += escapeText(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + escapeText(s.slice(last));
}

function link(href, label) {
  // marked reads <url|text> as an autolink whose href includes "|text".
  if (href.includes('|') || !label || label === href) return `<${href}>`;
  return `<${href}|${label}>`;
}

function inline(tokens = []) {
  return tokens.map((t) => {
    switch (t.type) {
      case 'text': return t.tokens ? inline(t.tokens) : escapeKeepingSequences(t.text);
      case 'escape': return escapeText(t.text);
      case 'strong': return `*${inline(t.tokens)}*`;
      case 'em': return `_${inline(t.tokens)}_`;
      case 'del': return `~${inline(t.tokens)}~`;
      case 'codespan': return `\`${escapeText(t.text)}\``;
      case 'br': return '\n';
      case 'link': return link(t.href, t.autolink ? '' : inline(t.tokens));
      case 'image': return link(t.href, escapeText(t.text));
      default: return escapeKeepingSequences(t.raw ?? t.text ?? '');
    }
  }).join('');
}

const indent = (s, pad) => s.split('\n').join(`\n${pad}`);

function block(t) {
  switch (t.type) {
    case 'space':
    case 'def':
      return null;
    case 'paragraph':
    case 'text':
      return t.tokens ? inline(t.tokens) : escapeKeepingSequences(t.text);
    case 'heading': return `*${inline(t.tokens)}*`;
    case 'code': return `\`\`\`\n${escapeText(t.text)}\n\`\`\``;
    case 'blockquote': return blocks(t.tokens).split('\n').map((l) => `> ${l}`).join('\n');
    case 'hr': return '---';
    case 'list':
      return t.items.map((item, i) => {
        const marker = t.ordered ? `${Number(t.start || 1) + i}. ` : '• ';
        const box = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';
        const body = blocks(item.tokens.filter((c) => c.type !== 'checkbox'), item.loose ? '\n\n' : '\n');
        return marker + box + indent(body, ' '.repeat(marker.length));
      }).join(t.loose ? '\n\n' : '\n');
    case 'table':
      return [t.header, ...t.rows].map((row) => row.map((cell) => inline(cell.tokens)).join(' | ')).join('\n');
    default:
      return escapeKeepingSequences(t.raw ?? t.text ?? '');
  }
}

function blocks(tokens, sep = '\n\n') {
  return tokens.map(block).filter((s) => s !== null).join(sep);
}

export function markdownToMrkdwn(markdown) {
  return blocks(Lexer.lex(markdown)).trim();
}

// A section block's text is capped at 3000 characters, so long mrkdwn is
// split at line breaks.
export function mrkdwnSections(text, max = SECTION_MAX) {
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf('\n', max);
    chunks.push(rest.slice(0, cut > 0 ? cut : max));
    rest = rest.slice(cut > 0 ? cut + 1 : max);
  }
  chunks.push(rest);
  return chunks.filter((t) => t.trim()).map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } }));
}

// Text as blocks, then controls (buttons, form fields), then the footer in a
// context block, the small grey line Slack's own "Sent using Claude"
// attribution uses. text is what Slack shows where blocks can't be rendered,
// such as notifications.
export function messageBlocks(text, { markdown, footer, controls = [] }) {
  const body = markdown ? [{ type: 'markdown', text }] : mrkdwnSections(text);
  const plain = markdown ? markdownToMrkdwn(text) : text;
  const context = footer ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] }] : [];
  return { text: footer ? `${plain}\n${footer}` : plain, blocks: [...body, ...controls, ...context] };
}
