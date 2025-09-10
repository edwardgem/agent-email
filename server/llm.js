const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function extractHtmlFromOutput(text) {
  // Prefer ```html ... ``` blocks
  const fenceMatch = text.match(/```html\s*[\r\n]+([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) return fenceMatch[1].trim();
  // If looks like HTML, return as-is
  if (/(<!DOCTYPE|<html[\s>]|<body[\s>]|<table[\s>]|<div[\s>])/i.test(text)) return text;
  // Fallback: extract lines with tags
  const lines = text.split(/\r?\n/).filter(l => /<[^>]+>/.test(l));
  return lines.join('\n').trim() || text.trim();
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
  endpoint = endpoint || process.env.LLM_ENDPOINT || 'http://127.0.0.1:11434';
  model = model || process.env.LLM_MODEL || 'llama3.1';
  // Use non-streaming generate API for simplicity
  const resp = await httpJson({
    endpoint,
    path: '/api/generate',
    body: {
      model,
      prompt,
      stream: false,
      options: { temperature: 0.3, ...options },
    },
  });
  const text = resp.response || '';
  const html = extractHtmlFromOutput(text);
  return { text, html };
}

async function generateWithOpenAI({ apiKey, model, prompt, options = {} }) {
  apiKey = apiKey || process.env.OPENAI_API_KEY;
  model = model || process.env.LLM_MODEL || 'gpt-4o-mini';
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
      model,
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
  const html = extractHtmlFromOutput(text);
  return { text, html };
}

async function generateHtml({ provider, model, endpoint, prompt, options }) {
  provider = provider || process.env.LLM_PROVIDER || 'ollama';
  if (provider === 'openai') {
    return generateWithOpenAI({ model, prompt, options });
  }
  // default to ollama
  return generateWithOllama({ endpoint, model, prompt, options });
}

module.exports = { generateHtml, extractHtmlFromOutput };
