// Calls a model through OpenRouter's chat completions API with a JSON-schema response format.
// The key is sent only in the Authorization header and never appears in an error message.
const endpoint = 'https://openrouter.ai/api/v1/chat/completions';

export function createOpenRouterLlm({ apiKey, fetchImpl = fetch, timeoutMs = 25000, referer } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('An OpenRouter API key is required.');
  const headers = { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json', 'X-Title': 'Tender Desk',
    ...(referer && { 'HTTP-Referer': referer }) };

  async function once({ model, system, user, jsonSchema, name, reasoning, timeoutMs: callTimeout }) {
    const response = await fetchImpl(endpoint, {
      method: 'POST', headers, signal: AbortSignal.timeout(callTimeout ?? timeoutMs),
      body: JSON.stringify({ model, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_schema', json_schema: { name, strict: true, schema: jsonSchema } }, ...(reasoning && { reasoning }) }),
    });
    if (!response.ok) {
      const detail = await response.json().then((body) => body?.error?.message, () => undefined);
      throw new Error(`HTTP ${response.status}${typeof detail === 'string' ? `: ${detail}` : ''}`);
    }
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    try {
      return JSON.parse(typeof content === 'string' ? content.replace(/^```(?:json)?\s*|\s*```$/g, '') : '');
    } catch {
      throw new Error(body?.error?.message ? `provider error: ${body.error.message}` : 'the reply was not JSON');
    }
  }
  // A short, key-free reason for the admin: HTTP status and OpenRouter's message, a timeout, or unreadable output.
  const timedOut = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError';
  const reasonOf = (error, limit) => {
    const raw = timedOut(error) ? `timed out after ${Math.round(limit / 1000)}s` : String(error?.message ?? error);
    return raw.split(apiKey.trim()).join('<key>').replace(/\s+/g, ' ').slice(0, 200);
  };

  return async function llm(request) {
    // One retry for a server error or unreadable reply; never after a timeout, which would double a slow wait.
    let reason;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await once(request); } catch (error) {
        reason = reasonOf(error, request.timeoutMs ?? timeoutMs);
        if (timedOut(error)) break;
      }
    }
    throw new Error(`model unavailable: ${reason}`);
  };
}
