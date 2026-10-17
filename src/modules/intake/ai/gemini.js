const { INSTRUCTIONS, parseJson } = require('./prompt');

const API_BASE = () => (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');

function toParts(input) {
  const parts = [{ text: INSTRUCTIONS }];
  for (const text of input.texts) parts.push({ text });
  for (const file of input.files) parts.push({ inline_data: { mime_type: file.mimeType, data: file.base64 } });
  return parts;
}

async function post(url, apiKey, body) {
  return fetch(url, {
    method: 'POST',
    // Key in a header, not the URL, so it never lands in proxy or access logs.
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
}

async function read(settings, input) {
  if (!settings.geminiApiKey) throw Object.assign(new Error('Gemini API key is not set'), { config: true });
  const model = settings.geminiModel || 'gemini-3.5-flash-lite';
  const url = `${API_BASE()}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: toParts(input) }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
  };
  let response = await post(url, settings.geminiApiKey, body);
  if (response.status === 400) {
    // Some models refuse a zero thinking budget; retry without it.
    delete body.generationConfig.thinkingConfig;
    response = await post(url, settings.geminiApiKey, body);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Gemini returned ${response.status}`);
    error.status = response.status;
    error.config = response.status === 401 || response.status === 403;
    throw error;
  }
  const text = (payload?.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('').trim();
  if (!text) throw new Error('Gemini returned an empty reading');
  return {
    raw: parseJson(text),
    model,
    usage: {
      inputTokens: payload?.usageMetadata?.promptTokenCount || 0,
      outputTokens: payload?.usageMetadata?.candidatesTokenCount || 0,
    },
  };
}

module.exports = { name: 'gemini', read, supportsPdf: true };
