// Pure helpers for the zyven-ai function (no network, easy to test).
import { ACTIONS } from './prompt.ts';

export const HISTORY_MESSAGES = 24;  // earlier messages the AI sees
export const HISTORY_CHARS = 24000;  // and at most this many characters of them

// Strip things that look like credentials before anything is stored or sent.
const SECRETISH = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,  // JWTs (session tokens, API keys)
  /sk-ant-[A-Za-z0-9_-]{10,}/g,                                     // Anthropic keys
  /sb_(secret|publishable)_[A-Za-z0-9_-]{10,}/g,                    // Supabase keys
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,                 // other common API keys
];
export function redact(s: string): string {
  let out = s;
  for (const re of SECRETISH) out = out.replace(re, '[removed]');
  return out;
}

// Diagnostics: a fixed list of safe fields, plain values only.
const DIAG_KEYS: Record<string, 'string' | 'number' | 'boolean'> = {
  appVersion: 'string', platform: 'string', online: 'boolean', signedIn: 'boolean',
  serverReachable: 'boolean', serverLatencyMs: 'number', realtime: 'string', lastSyncAgoSec: 'number',
  storageReachable: 'boolean', aiService: 'string', chats: 'number', contacts: 'number', groups: 'number',
  failedMessages: 'number', notificationsAllowed: 'string', microphone: 'string', theme: 'string',
  language: 'string', screen: 'string', checkedAt: 'string',
};
export function cleanDiagnostics(d: unknown): Record<string, unknown> | null {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const src = d as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, t] of Object.entries(DIAG_KEYS)) {
    const v = src[k];
    if (v === undefined || v === null) continue;
    if (t === 'string' && typeof v === 'string') out[k] = redact(v.slice(0, 80));
    else if (t === 'number' && typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v);
    else if (t === 'boolean' && typeof v === 'boolean') out[k] = v;
  }
  if (Array.isArray(src.recentErrors)) {
    out.recentErrors = src.recentErrors.filter(e => typeof e === 'string').slice(0, 8)
      .map(e => redact(String(e).slice(0, 160)).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]'));
  }
  return Object.keys(out).length ? out : null;
}

// The model may end a reply with [[open:target]] tags. Keep only real targets.
export function extractActions(text: string): { text: string; actions: string[] } {
  const actions: string[] = [];
  const cleaned = text.replace(/\[\[open:([a-z-]+)\]\]/g, (_m, t: string) => {
    if (ACTIONS[t] && !actions.includes(t) && actions.length < 3) actions.push(t);
    return '';
  }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: cleaned, actions };
}

export type Msg = { role: 'user' | 'assistant'; content: string };

export function buildHistory(rows: Msg[]): Msg[] {
  // Newest last; drop the oldest until it fits; must start with a user turn.
  let list = rows.slice(-HISTORY_MESSAGES);
  let total = list.reduce((n, m) => n + m.content.length, 0);
  while (list.length > 1 && total > HISTORY_CHARS) { total -= list[0].content.length; list = list.slice(1); }
  while (list.length && list[0].role !== 'user') list = list.slice(1);
  // Merge accidental repeats of the same role (e.g. a retried question).
  const merged: Msg[] = [];
  for (const m of list) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else merged.push({ ...m });
  }
  return merged;
}

