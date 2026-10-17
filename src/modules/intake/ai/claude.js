const Anthropic = require('@anthropic-ai/sdk').default;
const { INSTRUCTIONS, SCHEMA, parseJson } = require('./prompt');

// Default model is Claude Opus 5.5; a cheaper model such as claude-haiku-5-5
// can be chosen on the setup screen.
const DEFAULT_MODEL = 'claude-opus-5-5';
// When Opus declines a request, the API re-runs it on Anthropic's recommended
// fallback model instead of returning the refusal (server-side fallbacks).
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function client(apiKey) {
  return new Anthropic({
    apiKey,
    ...(process.env.ANTHROPIC_API_BASE ? { baseURL: process.env.ANTHROPIC_API_BASE } : {}),
    timeout: 180000,
    maxRetries: 2,
  });
}

function toContent(input) {
  const content = [];
  for (const file of input.files) {
    if (file.mimeType === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.base64 } });
    } else {
      content.push({ type: 'image', source: { type: 'base64', media_type: file.mimeType, data: file.base64 } });
    }
  }
  content.push({ type: 'text', text: [INSTRUCTIONS, ...input.texts].join('\n\n') });
  return content;
}

async function read(settings, input) {
  if (!settings.claudeApiKey) throw Object.assign(new Error('Claude API key is not set'), { config: true });
  const model = settings.claudeModel || DEFAULT_MODEL;
  const request = {
    model,
    max_tokens: 16000,
    messages: [{ role: 'user', content: toContent(input) }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
  };

  let response;
  try {
    response = model.startsWith('claude-opus-5')
      ? await client(settings.claudeApiKey).beta.messages.create({ ...request, betas: [FALLBACK_BETA], fallbacks: 'default' })
      : await client(settings.claudeApiKey).messages.create(request);
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      const wrapped = new Error(`Claude: ${error.message}`);
      wrapped.status = error.status;
      wrapped.config = error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError;
      throw wrapped;
    }
    throw error;
  }

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined to read this message');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Claude ran out of room before finishing the reading');
  }
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!text.trim()) throw new Error('Claude returned an empty reading');
  return {
    raw: parseJson(text),
    model: response.model || model,
    usage: {
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0,
    },
  };
}

module.exports = { name: 'claude', read, supportsPdf: true, DEFAULT_MODEL };
