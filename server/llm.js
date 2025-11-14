const http = require('http');
const https = require('https');

const REASONING_PREAMBLE = `You are a careful assistant. Return ONLY JSON per the schema. No hidden chain-of-thought. Explicitly describe your plan and provide a reasoning and thought summary. In your reasoning, include key_facts, assumptions, and uncertainty_level.`;

const OUTPUT_CONTRACT_SCHEMA = `{
  "reasoning": {
    "summary": "<string>",
    "key_facts": "<string>",
    "policy_rules_applied": "<string>",
    "assumptions": "<string>",
    "uncertainty_level": "<low | medium | high>"
  },
  "answer": "<string>"
}`;

function ensureJsonString(input) {
  if (!input) throw new Error('Empty response from LLM');
  let trimmed = String(input).trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    trimmed = fenceMatch[1].trim();
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    trimmed = trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function parseReasonedJson(text) {
  try {
    const payload = JSON.parse(ensureJsonString(text));
    if (!payload || typeof payload !== 'object') throw new Error('Response is not a JSON object');
    if (!payload.answer || typeof payload.answer !== 'string') {
      throw new Error('Response missing string "answer" field');
    }
    if (!payload.reasoning || typeof payload.reasoning !== 'object') {
      throw new Error('Response missing "reasoning" object');
    }
    return payload;
  } catch (err) {
    const message = err && err.message ? err.message : err;
    throw new Error(`Unable to parse LLM JSON response: ${message}`);
  }
}

function extractHtmlFromOutput(text) {
  if (!text) return '';
  // Prefer ```html ... ``` blocks
  const fenceMatch = text.match(/```html\s*[\r\n]+([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) return fenceMatch[1].trim();
  // If looks like HTML, return as-is
  if (/(<!DOCTYPE|<html[\s>]|<body[\s>]|<table[\s>]|<div[\s>])/i.test(text)) return text;
  // Fallback: extract lines with tags
  const lines = text.split(/\r?\n/).filter(l => /<[^>]+>/.test(l));
  return lines.join('\n').trim() || text.trim();
}

function buildReasoningPrompt(userPrompt) {
  const header = `${REASONING_PREAMBLE}\nReturn ONLY JSON that conforms exactly to this schema:\n${OUTPUT_CONTRACT_SCHEMA}`;
  return `${header}\n\nCaller prompt:\n${userPrompt}`;
}

function httpJson({ method = 'POST', endpoint, path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const isHttps = endpoint.startsWith('https://');
    const u = new URL(endpoint);
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: (u.pathname === '/' ? '' : u.pathname) + (p || ''),
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
    };
    const mod = isHttps ? https : http;
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function generateWithOllama({ endpoint, model, prompt, options = {} }) {
  const resolvedEndpoint = endpoint || process.env.LLM_ENDPOINT || 'http://127.0.0.1:11434';
  const resolvedModel = model || process.env.LLM_MODEL || 'llama3.1';
  // Use non-streaming generate API for simplicity
  const resp = await httpJson({
    endpoint: resolvedEndpoint,
    path: '/api/generate',
    body: {
      model: resolvedModel,
      prompt,
      stream: false,
      options: { temperature: 0.3, ...options },
    },
  });
  const text = resp.response || '';
  return { text, model: resolvedModel };
}

async function generateWithOpenAI({ apiKey, model, prompt, options = {} }) {
  apiKey = apiKey || process.env.OPENAI_API_KEY;
  const resolvedModel = model || process.env.LLM_MODEL || 'gpt-4o-mini';
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY for OpenAI provider');
  // Map generic options into OpenAI fields when available
  const temperature = options.temperature ?? 0.3;
  const top_p = options.top_p;
  const presence_penalty = options.presence_penalty;
  const frequency_penalty = options.frequency_penalty;
  const resp = await httpJson({
    endpoint: 'https://api.openai.com',
    path: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: {
      model: resolvedModel,
      messages: [
        { role: 'user', content: prompt },
      ],
      temperature,
      ...(top_p !== undefined ? { top_p } : {}),
      ...(presence_penalty !== undefined ? { presence_penalty } : {}),
      ...(frequency_penalty !== undefined ? { frequency_penalty } : {}),
    },
  });
  const text = resp.choices?.[0]?.message?.content || '';
  return { text, model: resp.model || resolvedModel };
}

async function generateWithAnthropic({ apiKey, model, prompt, options = {} }) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!key) throw new Error('Missing ANTHROPIC_API_KEY for Anthropic provider');
  const resolvedModel = model || process.env.LLM_MODEL || process.env.CLAUDE_MODEL || 'claude-3-sonnet-20240229';
  const temperature = options.temperature ?? 0.3;
  const top_p = options.top_p;
  const max_tokens = options.max_tokens || 2048;
  const body = {
    model: resolvedModel,
    max_tokens,
    temperature,
    messages: [
      { role: 'user', content: prompt },
    ],
  };
  if (top_p !== undefined) body.top_p = top_p;
  if (options.system) body.system = options.system;
  const resp = await httpJson({
    endpoint: 'https://api.anthropic.com',
    path: '/v1/messages',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body,
  });
  let text = '';
  if (Array.isArray(resp.content)) {
    text = resp.content
      .map((chunk) => (chunk && typeof chunk.text === 'string') ? chunk.text : '')
      .filter(Boolean)
      .join('\n')
      .trim();
  } else if (resp.content && typeof resp.content === 'string') {
    text = resp.content;
  }
  return { text, model: resp.model || resolvedModel };
}

async function generateHtml({ provider, model, endpoint, prompt, options }) {
  const wrappedPrompt = buildReasoningPrompt(prompt);
  const normalizedProvider = (provider || process.env.LLM_PROVIDER || 'ollama').toLowerCase();
  let responseText = '';
  let modelUsed = model;

  if (normalizedProvider === 'openai') {
    const resp = await generateWithOpenAI({ model, prompt: wrappedPrompt, options });
    responseText = resp.text;
    modelUsed = resp.model;
  } else if (normalizedProvider === 'anthropic' || normalizedProvider === 'claude') {
    const resp = await generateWithAnthropic({ model, prompt: wrappedPrompt, options });
    responseText = resp.text;
    modelUsed = resp.model;
  } else {
    const resp = await generateWithOllama({ endpoint, model, prompt: wrappedPrompt, options });
    responseText = resp.text;
    modelUsed = resp.model;
  }

  const parsed = parseReasonedJson(responseText);
  const html = extractHtmlFromOutput(parsed.answer);
  return {
    text: responseText,
    answer: parsed.answer,
    html,
    reasoning: parsed.reasoning,
    prompt: wrappedPrompt,
    model: modelUsed,
  };
}

module.exports = {
  generateHtml,
  extractHtmlFromOutput,
  buildReasoningPrompt,
};
