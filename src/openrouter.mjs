// Calls a model through OpenRouter's chat completions API with a JSON-schema response format.
// The key is sent only in the Authorization header and never appears in an error message.
const endpoint = 'https://openrouter.ai/api/v1/chat/completions';

export function createOpenRouterLlm({ apiKey, fetchImpl = fetch, timeoutMs = 25000, referer } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('An OpenRouter API key is required.');
  const headers = { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json', 'X-Title': 'Tender Desk',
    ...(referer && { 'HTTP-Referer': referer }) };

  async function once({ model, system, user, jsonSchema, name }) {
    const response = await fetchImpl(endpoint, {
      method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_schema', json_schema: { name, strict: true, schema: jsonSchema } } }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    return JSON.parse(typeof content === 'string' ? content.replace(/^```(?:json)?\s*|\s*```$/g, '') : '');
  }

  return async function llm(request) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await once(request); } catch { /* retried once, then reported without detail */ }
    }
    throw new Error('model unavailable');
  };
}
