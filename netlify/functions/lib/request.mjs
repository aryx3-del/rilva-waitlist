const fail = (status, message) => Object.assign(new Error(message), { status });

// Count bytes while streaming; Content-Length is optional and cannot be trusted.
export async function readApiPayload(request, maxBytes = 16384) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw fail(415, 'Send this request as application/json.');
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) throw fail(413, 'This request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw fail(400, 'Send a valid JSON request.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // Cancellation is best effort; a stalled producer must not delay rejection.
        void reader.cancel().catch(() => {});
        throw fail(413, 'This request is too large.');
      }
      chunks.push(Buffer.from(value));
    }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || (body.data !== undefined && (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)))) throw fail(400, 'Send a JSON object with valid feature data.');
    return body;
  } catch (error) {
    if (error.status) throw error;
    throw fail(400, 'Send a valid JSON request.');
  } finally { reader.releaseLock(); }
}
