const { INSTRUCTIONS, parseJson } = require('./prompt');

// Any server speaking the OpenAI chat-completions API: a self-hosted open
// model (Ollama, vLLM, LM Studio) or a hosted one. Scanned PDFs without a
// text layer can't be sent this way; their text layer is used instead.
async function read(settings, input) {
  const base = String(settings.openaiBaseUrl || '').replace(/\/$/, '');
  if (!base || !settings.openaiModel) {
    throw Object.assign(new Error('Set the server address and model for the open-model reader'), { config: true });
  }
  const content = [{ type: 'text', text: [INSTRUCTIONS, ...input.texts].join('\n\n') }];
  for (const file of input.files) {
    if (file.mimeType.startsWith('image/')) {
      content.push({ type: 'image_url', image_url: { url: `data:${file.mimeType};base64,${file.base64}` } });
    }
  }
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(settings.openaiApiKey ? { Authorization: `Bearer ${settings.openaiApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: settings.openaiModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(180000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Open-model reader returned ${response.status}`);
    error.status = response.status;
    error.config = response.status === 401 || response.status === 403 || response.status === 404;
    throw error;
  }
  const text = payload?.choices?.[0]?.message?.content || '';
  if (!String(text).trim()) throw new Error('The open-model reader returned an empty reading');
  return {
    raw: parseJson(text),
    model: payload.model || settings.openaiModel,
    usage: {
      inputTokens: payload?.usage?.prompt_tokens || 0,
      outputTokens: payload?.usage?.completion_tokens || 0,
    },
  };
}

module.exports = { name: 'openai', read, supportsPdf: false };
