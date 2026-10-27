// A stand-in for the Claude API, used ONLY by automated tests in GitHub
// Actions. The real app never talks to this; the zyven-ai function only uses
// it when the test sets AI_API_URL. It lets the tests check exactly what the
// server function sends (and that it never sends tokens or other people's
// messages) without paying for real AI calls.
//
//   POST /v1/messages     behaves like the Messages API
//   GET  /requests        what it received (for the tests)
//   POST /control         {"fail": N} → the next N calls answer 503
import { createServer } from 'node:http';

const KEY = process.env.MOCK_AI_KEY || 'test-key-zyven-0123456789abcdef';
const PORT = +(process.env.MOCK_AI_PORT || 8787);
const received = [];
let failNext = 0;

const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/requests') return send(res, 200, received);
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (req.method === 'POST' && req.url === '/control') { const j = JSON.parse(raw || '{}'); failNext = +j.fail || 0; if (j.reset) received.length = 0; return send(res, 200, { ok: true }); }
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) return send(res, 404, { error: { type: 'not_found_error', message: 'not found' } });
    let body = {};
    try { body = JSON.parse(raw); } catch { return send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad json' } }); }
    received.push({ at: Date.now(), headers: { key: req.headers['x-api-key'] === KEY ? 'valid' : 'invalid', version: req.headers['anthropic-version'] }, body });
    if (req.headers['x-api-key'] !== KEY) return send(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    if (failNext > 0) { failNext--; return send(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }); }
    const msgs = body.messages || [];
    const last = msgs[msgs.length - 1];
    const text = typeof last?.content === 'string' ? last.content : '';
    if (last?.role !== 'user') return send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'last message must be user' } });
    const question = text.split('\n\n<app_diagnostics')[0];
    const arabic = /[؀-ۿ]/.test(question);
    const lines = [
      arabic ? `جواب تجريبي على: ${question}` : `Mock answer to: ${question}`,
      '',
      `1. Turns in context: ${msgs.length}`,
      `2. Diagnostics received: ${/<app_diagnostics/.test(text) ? 'yes' : 'no'}`,
      `3. Testing mode: ${/App Testing Assistant mode is ON/.test(JSON.stringify(body.system)) ? 'yes' : 'no'}`,
      '- [ ] a **bold** checklist item with `code`',
    ];
    if (/privacy/i.test(question) || /خصوصية/.test(question)) lines.push('', '[[open:privacy]]', '[[open:delete-everything]]');
    if (/bug report/i.test(question)) lines.push('', '### Bug report', '**Title:** Cannot add a contact', '**Status:** Possible issue', '**Severity:** Medium', '**Steps to reproduce:**', '1. Open Contacts', '2. Tap Add', '**Expected:** The person is added', '**Actual:** An error appears', '**How often:** every time');
    send(res, 200, {
      id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: lines.join('\n') }],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
  });
}).listen(PORT, '0.0.0.0', () => console.log(`mock AI listening on ${PORT}`));
