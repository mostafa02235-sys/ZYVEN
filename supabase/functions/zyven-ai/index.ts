// ZYVEN AI — server function (Supabase Edge Function).
//
// The app calls this with the signed-in user's session. This function:
//   1. checks who the user is (no session = no answer),
//   2. counts the request against the user's limits (ai_take_quota),
//   3. loads that user's own AI conversation (row level security applies,
//      because every database call here runs as the user, not as admin),
//   4. sends the conversation to the Claude API with the key that lives
//      only in this function's secrets (ANTHROPIC_API_KEY),
//   5. saves the reply and returns it.
//
// It never reads ZYVEN chats between people. The only content sent to the AI
// is what the user typed in the ZYVEN AI screen, plus app diagnostics when the
// user turned that on for a message.
//
// Secrets (Supabase dashboard → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY  required. Your key from console.anthropic.com.
//   AI_MODEL           optional. Default: claude-haiku-5-5.
//   AI_API_URL         optional. Only for automated tests.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { SYSTEM_PROMPT, TESTING_PROMPT } from './prompt.ts';
import { redact, cleanDiagnostics, extractActions, buildHistory, HISTORY_MESSAGES, type Msg } from './helpers.ts';

const MODEL = Deno.env.get('AI_MODEL') || 'claude-haiku-5-5';
const API_URL = Deno.env.get('AI_API_URL') || 'https://api.anthropic.com/v1/messages';
const MAX_INPUT = 4000;          // characters a user can send at once
const MAX_OUTPUT_TOKENS = 4000;  // includes the model's thinking
// Lower effort = faster, cheaper answers. Set AI_EFFORT=none for models without the setting.
const EFFORT = (Deno.env.get('AI_EFFORT') || 'low').toLowerCase();
const TIMEOUT_MS = 45000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  reply(status, { error, message, ...extra });

async function callClaude(key: string, system: string, messages: Msg[]): Promise<string> {
  let lastErr: Error | null = null;
  let useEffort = EFFORT !== 'none';
  const started = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(5000, TIMEOUT_MS - (Date.now() - started)));
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages,
          ...(useEffort ? { output_config: { effort: EFFORT } } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (data.stop_reason === 'refusal') return 'Sorry, I can’t help with that one. Is there something else in ZYVEN I can help with?';
        const text = (data.content || []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('').trim();
        if (!text) throw Object.assign(new Error('Empty reply'), { code: 'AI_EMPTY' });
        return text;
      }
      const type = data?.error?.type || '';
      if (res.status === 401 || res.status === 403 || type === 'authentication_error' || type === 'permission_error') throw Object.assign(new Error('AI key rejected'), { code: 'AI_KEY_INVALID' });
      if (res.status === 400 && useEffort && /effort|output_config/i.test(data?.error?.message || '')) { useEffort = false; continue; }
      if (res.status === 400 && /credit|balance|billing/i.test(data?.error?.message || '')) throw Object.assign(new Error('No AI credit'), { code: 'AI_NO_CREDIT' });
      if (res.status === 400 || res.status === 404) throw Object.assign(new Error(`AI request rejected: ${data?.error?.message || res.status}`), { code: 'AI_BAD_REQUEST' });
      lastErr = Object.assign(new Error(`AI service error ${res.status}`), { code: res.status === 429 ? 'AI_BUSY' : res.status === 529 ? 'AI_BUSY' : 'AI_UNAVAILABLE' });
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code && !['AI_BUSY', 'AI_UNAVAILABLE'].includes(err.code)) throw err;
      lastErr = err.name === 'AbortError' ? Object.assign(new Error('AI timed out'), { code: 'AI_TIMEOUT' }) : (err.code ? err : Object.assign(new Error(String(err)), { code: 'AI_UNAVAILABLE' }));
      if (lastErr.code === 'AI_TIMEOUT') throw lastErr;
    } finally { clearTimeout(timer); }
    if (attempt < 2) await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
    if (Date.now() - started > TIMEOUT_MS - 5000) break;
  }
  throw lastErr || new Error('AI unavailable');
}

const AI_ERRORS: Record<string, [number, string]> = {
  AI_KEY_INVALID: [503, 'ZYVEN AI isn’t set up correctly on the server (the AI key was rejected).'],
  AI_NO_CREDIT: [503, 'ZYVEN AI is paused: the AI account has run out of credit.'],
  AI_BUSY: [503, 'The AI service is busy right now. Try again in a moment.'],
  AI_UNAVAILABLE: [502, 'The AI service didn’t respond. Try again in a moment.'],
  AI_TIMEOUT: [504, 'The AI took too long to answer. Try again, or ask a shorter question.'],
  AI_EMPTY: [502, 'The AI sent an empty answer. Try again.'],
  AI_BAD_REQUEST: [502, 'The AI couldn’t process this request. Try rephrasing it.'],
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail(405, 'METHOD', 'Use POST.');

  const auth = req.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S+/.test(auth)) return fail(401, 'NOT_SIGNED_IN', 'Sign in to use ZYVEN AI.');
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: who, error: whoErr } = await db.auth.getUser(auth.replace(/^Bearer\s+/, ''));
  if (whoErr || !who?.user) return fail(401, 'NOT_SIGNED_IN', 'Your session has expired. Sign in again.');
  const me = who.user.id;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail(400, 'BAD_REQUEST', 'The request was not valid JSON.'); }
  const key = Deno.env.get('ANTHROPIC_API_KEY') || '';

  // Status check: is the AI configured? Never returns the key.
  if (body.op === 'status') return reply(200, { configured: key.length > 20, model: MODEL });
  if (body.op !== 'chat') return fail(400, 'BAD_REQUEST', 'Unknown request.');

  let mode = body.mode === 'testing' ? 'testing' : 'assistant';
  const retry = body.retry === true;
  const lang = body.lang === 'ar' ? 'ar' : 'en';
  const text = typeof body.text === 'string' ? redact(body.text.trim()) : '';
  if (!retry && !text) return fail(400, 'EMPTY', 'Type a message first.');
  if (text.length > MAX_INPUT) return fail(400, 'TOO_LONG', `Messages to ZYVEN AI can be up to ${MAX_INPUT} characters.`);
  const diagnostics = cleanDiagnostics(body.diagnostics);
  let convId = typeof body.conversation_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.conversation_id) ? body.conversation_id : null;

  if (!key) return fail(503, 'AI_NOT_CONFIGURED', 'ZYVEN AI isn’t switched on yet. The app owner needs to add an AI key on the server.');

  // Load or create the conversation (as the user: RLS only shows their own).
  let history: Msg[] = [];
  if (convId) {
    const { data: conv } = await db.from('ai_conversations').select('id,mode').eq('id', convId).maybeSingle();
    if (!conv) return fail(404, 'NOT_FOUND', 'That ZYVEN AI conversation no longer exists.');
    mode = conv.mode === 'testing' ? 'testing' : 'assistant';
    const { data: rows, error } = await db.from('ai_messages').select('role,content').eq('conversation_id', convId)
      .order('created_at', { ascending: false }).limit(HISTORY_MESSAGES + 1);
    if (error) return fail(500, 'DB', 'Couldn’t load this conversation. Try again.');
    history = (rows || []).reverse() as Msg[];
  } else if (retry) {
    return fail(400, 'BAD_REQUEST', 'Nothing to retry.');
  }
  if (retry && history[history.length - 1]?.role !== 'user') return fail(409, 'NOTHING_TO_RETRY', 'This question already has an answer.');

  const { data: quota, error: qErr } = await db.rpc('ai_take_quota');
  if (qErr) return fail(500, 'DB', 'Couldn’t check your usage. Try again.');
  if (quota !== 'ok') {
    const msg = {
      minute: 'You’re sending questions very quickly. Wait a minute and try again.',
      hour: 'You’ve reached this hour’s ZYVEN AI limit (60 questions). Try again later.',
      day: 'You’ve reached today’s ZYVEN AI limit (200 questions). It resets within 24 hours.',
      global: 'ZYVEN AI has reached its daily limit for everyone. Try again tomorrow.',
    }[quota as string] || 'ZYVEN AI is limited right now. Try again later.';
    return fail(429, 'RATE_LIMITED', msg, { limit: quota });
  }

  if (!convId) {
    const title = text.replace(/\s+/g, ' ').slice(0, 60);
    const { data: conv, error } = await db.from('ai_conversations').insert({ user_id: me, mode, title }).select('id').single();
    if (error || !conv) return fail(500, 'DB', 'Couldn’t start a conversation. Try again.');
    convId = conv.id;
  }

  // Save the question first, so a failed answer can be retried.
  let userMsg = null;
  if (!retry) {
    const { data, error } = await db.from('ai_messages')
      .insert({ conversation_id: convId, user_id: me, role: 'user', content: text, shared_diagnostics: !!diagnostics })
      .select('id,role,content,actions,shared_diagnostics,created_at').single();
    if (error) return fail(500, 'DB', 'Couldn’t save your message. Try again.');
    userMsg = data;
    history.push({ role: 'user', content: text });
  }

  const msgs = buildHistory(history);
  if (diagnostics && msgs.length) {
    const last = msgs[msgs.length - 1];
    last.content += `\n\n<app_diagnostics source="ZYVEN app, collected on the user's phone just now, shared with the user's permission">\n${JSON.stringify(diagnostics, null, 1)}\n</app_diagnostics>`;
  }
  const system = SYSTEM_PROMPT
    + (mode === 'testing' ? '\n\n' + TESTING_PROMPT : '')
    + `\n\nThe phone's language is ${lang === 'ar' ? 'Arabic' : 'English'}. Reply in the language the user writes in. Today is ${new Date().toISOString().slice(0, 10)}.`;

  let answer: string;
  try {
    answer = await callClaude(key, system, msgs);
  } catch (e) {
    const code = (e as { code?: string }).code || 'AI_UNAVAILABLE';
    console.error('zyven-ai:', code, String((e as Error).message).slice(0, 200));
    const [status, message] = AI_ERRORS[code] || AI_ERRORS.AI_UNAVAILABLE;
    return fail(status, code, message, { conversation_id: convId, user_message: userMsg, retryable: true });
  }

  const { text: clean, actions } = extractActions(answer);
  const { data: botMsg, error: saveErr } = await db.from('ai_messages')
    .insert({ conversation_id: convId, user_id: me, role: 'assistant', content: (clean || '…').slice(0, 16000), actions })
    .select('id,role,content,actions,shared_diagnostics,created_at').single();
  if (saveErr) return fail(500, 'DB', 'The answer arrived but couldn’t be saved. Try again.', { conversation_id: convId, retryable: true });
  await db.from('ai_conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId);

  return reply(200, { conversation_id: convId, user_message: userMsg, assistant_message: botMsg });
});
