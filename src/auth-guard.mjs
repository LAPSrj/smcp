// Destructive-action barrier: a delete runs only after the human typed a
// sentence naming it. The check reads this session's Claude Code transcripts
// from disk, because every argument the agent passes is agent-controlled.
// Ported from asana-mcp's guard; nothing here imports another project.
//
// type:"user" records are not all human: task notifications, messages from
// other sessions, hook injections, slash-command and `!` output and
// compaction summaries use it too. Claude Code tags those with origin.kind,
// isMeta or promptSource, so only records tagged as human input count, plus
// the queued_command attachment for a message sent while the agent works.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code names a project folder after the cwd with every character
// other than a letter or digit replaced by "-" (/home/me/x/.tmp → -home-me-x--tmp).
export function encodeCwdForClaudeProject(cwd) {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

export function resolveTranscriptDir(cwd = process.cwd(), env = process.env) {
  if (env.SLACK_TRANSCRIPT_DIR) return env.SLACK_TRANSCRIPT_DIR;
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return path.join(configDir, 'projects', encodeCwdForClaudeProject(cwd));
}

export function buildPhrase(action, resourceLabel) {
  return `I authorize Slack to ${action} ${resourceLabel}`;
}

function normalize(s) {
  return s.toLowerCase().replace(/["'`‘’“”]/g, '').replace(/\s+/g, ' ').trim();
}

function textOf(content) {
  if (typeof content === 'string') return content.length ? content : null;
  if (!Array.isArray(content)) return null;
  const joined = content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
  return joined.length ? joined : null;
}

export function extractUserTypedText(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.type === 'attachment') {
    const a = entry.attachment;
    if (!a || a.type !== 'queued_command' || a.commandMode !== 'prompt' || a.isMeta) return null;
    const kind = a.origin?.kind;
    if (kind !== undefined && kind !== 'human') return null;
    return textOf(a.prompt);
  }
  if (entry.type !== 'user' || entry.isMeta) return null;
  const kind = entry.origin?.kind;
  const fromHuman = kind === 'human' || (kind === undefined && ['typed', 'queued', 'sdk'].includes(entry.promptSource));
  if (!fromHuman || !entry.message) return null;
  return textOf(entry.message.content);
}

function* jsonlRecords(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // a partly written last line
    }
  }
}

// Fails closed: a missing or unreadable transcript means not authorized.
export function verifyAuthorization(action, resourceLabel, { cwd, env, transcriptDir } = {}) {
  const requiredPhrase = buildPhrase(action, resourceLabel);
  const dir = transcriptDir ?? resolveTranscriptDir(cwd, env);
  const result = { authorized: false, requiredPhrase, transcriptDir: dir };
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return { ...result, reason: `No Claude Code transcript folder at ${dir}, so the authorization can't be checked.` };
  }
  const needle = normalize(requiredPhrase);
  for (const f of files) {
    for (const rec of jsonlRecords(path.join(dir, f))) {
      const text = extractUserTypedText(rec);
      if (text !== null && normalize(text).includes(needle)) return { ...result, authorized: true };
    }
  }
  return { ...result, reason: 'The authorization sentence is not in any message the user typed.' };
}

// The refusal an agent gets back, telling it how to ask the user.
export function refusal(action, resourceLabel, r) {
  return (
    `Blocked: this would ${action} ${resourceLabel}, which can't be undone. ${r.reason}\n\n` +
    'Only the user can authorize this. In your reply to the user, quote this sentence exactly, ' +
    `in a code block on its own, and ask them to type it in chat if they want to proceed:\n\n\`\`\`\n${r.requiredPhrase}\n\`\`\`\n\n` +
    "Don't paraphrase, shorten or translate it, because the server accepts only this sentence and looks for it only " +
    'in messages the user typed (it reads the conversation transcript), so your own text never counts. ' +
    'After the user sends it, call this tool again with the same arguments.'
  );
}
