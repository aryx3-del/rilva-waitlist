import { RILVA_INSTRUCTIONS } from '../../rilva-knowledge.mjs';

export function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 12) return null;
  let total = 0;
  const clean = [];
  for (const item of messages) {
    if (!['user', 'assistant'].includes(item?.role) || typeof item.content !== 'string') return null;
    const content = item.content.trim();
    total += content.length;
    if (!content || content.length > 2000 || total > 10000) return null;
    clean.push({ role: item.role, content });
  }
  return clean.at(-1).role === 'user' ? clean : null;
}

async function readPayload(request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 45000) { await reader.cancel(); return null; }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return null; }
}

// Burst protection is per instance. Provider/account quotas are the hard free
// limits. This Map is not a durable daily allowance across multiple instances.
export function createHandler({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const buckets = new Map();
  function allowed(key) {
    const time = now();
    for (const [id, bucket] of buckets) if (bucket.resetAt <= time) buckets.delete(id);
    if (!buckets.has(key) && buckets.size >= 5000) return false;
    const bucket = buckets.get(key) || { count: 0, resetAt: time + 60000 };
    bucket.count++;
    buckets.set(key, bucket);
    return bucket.count <= 8;
  }
  return async request => {
    const origin = request.headers.get('origin');
    const origins = new Set((env.RILVA_ALLOWED_ORIGINS || 'https://rilva-date.web.app,https://rilva-date.firebaseapp.com,https://rilva.date,http://localhost:800,http://localhost:8000,http://localhost:8888').split(',').map(s => s.trim()));
    if (env.URL) origins.add(env.URL);
    const cors = origin && origins.has(origin) ? { 'access-control-allow-origin': origin } : {};
    const reply = (data, status = 200, extra = {}) => new Response(data === null ? null : JSON.stringify(data), {
      status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Origin', ...cors, ...extra },
    });
    // Browser clients are restricted by origin. Native apps don't send an
    // Origin header; they are still protected by the verified Firebase token
    // check below, so allow origin-less requests for the Expo client.
    if (origin && !origins.has(origin)) return reply({ text: 'This app origin is not allowed.' }, 403);
    if (request.method === 'OPTIONS') return reply(null, 204, {
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '600',
    });
    if (request.method !== 'POST') return reply({ text: 'Use POST.' }, 405);
    const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!token || token.length > 4096) return reply({ text: 'Sign in and verify your email to use Rilva AI.' }, 401);
    if (!env.FIREBASE_WEB_API_KEY || !env.GROQ_API_KEY) return reply({ code: 'AI_NOT_CONFIGURED', text: 'Live Rilva AI is not connected yet. You can still use the App guide.' }, 503);
    const payload = await readPayload(request);
    const messages = validateMessages(payload?.messages);
    if (!messages) return reply({ text: 'Please send a shorter message (up to 2,000 characters).' }, 400);
    let user;
    try {
      const result = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: token }), signal: AbortSignal.timeout(8000), redirect: 'error',
      });
      if (result.ok) user = (await result.json()).users?.[0];
    } catch { return reply({ text: 'Sign-in verification is temporarily unavailable. Try again shortly.' }, 503); }
    if (!user?.localId || !user.emailVerified || user.disabled) return reply({ text: 'Sign in and verify your email to use Rilva AI.' }, 401);
    if (!allowed(user.localId)) return reply({ text: 'You’re sending messages quickly. Please wait a minute.' }, 429, { 'retry-after': '60' });
    try {
      const result = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: env.RILVA_AI_MODEL || 'qwen/qwen3.8-27b', messages: [{ role: 'system', content: RILVA_INSTRUCTIONS }, ...messages], temperature: 0.6, max_completion_tokens: 1200, stream: false }),
        signal: AbortSignal.timeout(20000), redirect: 'error',
      });
      if (result.status === 429) return reply({ text: 'Rilva AI’s free allowance is busy or used up. Try later, or switch to App guide.' }, 429, { 'retry-after': '60' });
      if (!result.ok) return reply({ text: 'Live AI is temporarily unavailable. Try again later or use App guide.' }, 503);
      const text = (await result.json()).choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) return reply({ text: 'No reply came through. Please try again.' }, 502);
      return reply({ text: text.trim(), mode: 'live' });
    } catch (error) {
      // Record only a coarse diagnostic, never headers, credentials or chat text.
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      const diagnostic = timedOut ? 'timeout' : /invalid character|invalid header|ByteString/i.test(String(error?.message)) ? 'invalid-header' : error instanceof TypeError ? 'connection-or-configuration' : 'unexpected-response';
      console.error('Rilva AI provider request failed:', diagnostic);
      return reply({ text: timedOut ? 'Rilva AI took too long to respond. Please try again.' : 'Rilva AI could not connect right now. Please try again later.' }, timedOut ? 504 : 503);
    }
  };
}

export default createHandler();
