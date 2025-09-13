require('dotenv').config();
// Helper to load a config.json file
function loadConfig(configPath) {
  try {
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.log('[ERROR] loadConfig:', e);
    return {};
  }
}
// Helper to format date as 'YYYY-MM-DD HH:mm:ss'
function formatDateYMDHMS(date) {
  const pad = n => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Helper to update meta.json for agent state
function updateMetaJson(metaPath, state) {
  try {
    if (!fs.existsSync(metaPath)) {
      throw new Error(`meta.json not found at ${metaPath}`);
    }
    const raw = fs.readFileSync(metaPath, 'utf8');
    const meta = JSON.parse(raw);
    const now = new Date();
    if (state === 'active') {
      meta.status = 'active';
      meta.started_at = formatDateYMDHMS(now);
    } else if (state === 'finished') {
      meta.status = 'finished';
      meta.finished_at = formatDateYMDHMS(now);
    } else if (state === 'abort') {
      meta.status = 'abort';
    }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    return null;
  } catch (e) {
    return e.message || String(e);
  }
}
// Minimal REST wrapper for the email agent
// No external deps: uses Node http + child_process

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { generateHtml } = require('./llm');
const { sendEmail } = require('./gmail');
const { agent_log, appendLogLocal } = require('./logger');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'config.json');
const OUTPUTS_DIR = path.join(REPO_ROOT, 'outputs');
const TMP_DIR = path.join(OUTPUTS_DIR, 'tmp');
const LOG_DIR = path.join(REPO_ROOT, 'logs');
const RUN_LOG = path.join(LOG_DIR, 'run.log');

fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

function appendLog(lines) {
  const stamp = new Date().toISOString();
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines);
  fs.appendFileSync(RUN_LOG, `[${stamp}] ` + text.replace(/\n/g, `\n[${stamp}] `) + '\n');
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Helper to resolve all paths based on instance folder or fallback to project root
function resolveAgentPaths(instancePath) {
  const root = instancePath ? path.resolve(instancePath) : path.resolve(__dirname, '..');
  return {
    root,
    config: path.join(root, 'config.json'),
    prompt: path.join(root, 'prompt.txt'),
    logs: path.join(root, 'logs'),
    runLog: path.join(root, 'logs', 'run.log'),
    artifacts: path.join(root, 'artifacts'),
    outputs: path.join(root, 'artifacts'), // alias for clarity
    tmp: path.join(root, 'artifacts', 'tmp'),
  };
}

function loadDefaultConfig() {
  try {
    if (!fs.existsSync(DEFAULT_CONFIG_PATH)) return {};
    const raw = fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.log('[ERROR] loadDefaultConfig:', e);
    return {};
  }
}

function isDebug() {
  const lvl = process.env.LOG_LEVEL;
  return typeof lvl === 'string' && lvl.toUpperCase() === 'DEBUG';
}

function writeTempPrompt(promptText, tmpDirOverride) {
  const fname = `prompt-${Date.now()}.txt`;
  const dir = tmpDirOverride || TMP_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, fname);
  fs.writeFileSync(p, promptText, 'utf8');
  return p;
}

function buildKeyInstructionsSection(instr) {
  if (!instr) return '';
  const bullets = instr
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => `- ${s}`)
    .join('\n');
  if (!bullets) return '';
  return `\n[KEY INSTRUCTIONS]\n${bullets}\n`;
}

function injectKeyInstructionsIntoPrompt(promptText, instrSection) {
  if (!instrSection) return promptText;
  // Always append [KEY INSTRUCTIONS] after the entire prompt
  return `${promptText}\n${instrSection}`;
}

// ---- Helper utilities for composing flows ----
function resolveContext(body, { activate } = {}) {
  // Determine instance folder from body.instance_id + AGENT_FOLDER
  let instancePath;
  if (body.instance_id) {
    const baseFolder = process.env.AGENT_FOLDER;
    if (!baseFolder) return { error: 'missing_env_AGENT_FOLDER' };
    instancePath = path.join(baseFolder, body.instance_id);
  }
  let ctx = { instancePath, paths: undefined, base: undefined };
  if (instancePath) {
    const paths = resolveAgentPaths(instancePath);
    const base = loadConfig(paths.config);
    fs.mkdirSync(paths.logs, { recursive: true });
    fs.mkdirSync(paths.artifacts, { recursive: true });
    if (activate) {
      const metaPath = path.join(paths.root, 'meta.json');
      const metaErr = updateMetaJson(metaPath, 'active');
      if (metaErr) return { error: `meta.json error: ${metaErr}`, paths, base };
      agent_log({ message: 'state - active', config: normalizeConfig(base), runLogOverride: paths.runLog });
      appendLogLocal(`instance folder: ${paths.root}`, paths.runLog);
      if (base.instance_id) {
        const lastPart = path.basename(paths.root);
        if (lastPart !== base.instance_id) return { error: `instance_id mismatch: config has '${base.instance_id}', folder is '${lastPart}'`, paths, base };
      }
    }
    ctx.paths = paths;
    ctx.base = base;
    return ctx;
  }
  const base = loadDefaultConfig();
  if (activate) agent_log({ message: 'state - active', config: normalizeConfig(base) });
  ctx.base = base;
  return ctx;
}

function resolvePromptPath(body, base, ctx) {
  if (body.promptText) return writeTempPrompt(body.promptText, ctx.paths ? ctx.paths.tmp : undefined);
  if (body.promptFile) return path.isAbsolute(body.promptFile) ? body.promptFile : (ctx.paths ? path.join(ctx.paths.root, body.promptFile) : path.join(REPO_ROOT, body.promptFile));
  if (base.PROMPT_FILE) return path.isAbsolute(base.PROMPT_FILE) ? base.PROMPT_FILE : (ctx.paths ? path.join(ctx.paths.root, base.PROMPT_FILE) : path.join(REPO_ROOT, base.PROMPT_FILE));
  return ctx.paths ? path.join(ctx.paths.root, 'prompt.txt') : path.join(REPO_ROOT, 'prompt.txt');
}

function resolveOutputPathRel(body, base, ctx) {
  if (body.htmlOutput) return body.htmlOutput;
  if (ctx.paths && ctx.paths.artifacts) return path.join(ctx.paths.artifacts, 'email.html');
  if (base.HTML_OUTPUT) return base.HTML_OUTPUT;
  return path.join('outputs', 'email.html');
}

function preparePromptText(promptText, body, base, ctx) {
  const userInstr = (body.instructions || '').trim();
  const keyInstrSection = buildKeyInstructionsSection(userInstr);
  const promptWithKeys = injectKeyInstructionsIntoPrompt(promptText, keyInstrSection);
  if (!userInstr) return { prompt: `${promptWithKeys}\n\nIMPORTANT: Your response must contain ONLY the HTML email content wrapped in \`\`\`html code blocks.` };
  const defaultBase = (ctx.paths && ctx.paths.artifacts) ? path.join(ctx.paths.artifacts, 'email.html') : (base.HTML_OUTPUT || path.join('outputs', 'email.html'));
  const srcPathRel = body.htmlPath || body.sourceHtmlPath || defaultBase;
  const srcPath = path.isAbsolute(srcPathRel) ? srcPathRel : (ctx.paths ? path.join(ctx.paths.root, srcPathRel) : path.join(REPO_ROOT, srcPathRel));
  let baseHtml = '';
  if (fs.existsSync(srcPath)) baseHtml = fs.readFileSync(srcPath, 'utf8');
  else if (body.htmlPath || body.sourceHtmlPath) return { error: { code: 'base_html_not_found', path: srcPathRel } };
  if (baseHtml) {
    return { prompt: `${promptWithKeys}\n\nYou are updating an existing HTML email. Here is the current HTML to modify:\n\n\`\`\`html\n${baseHtml}\n\`\`\`\n\nIMPORTANT: Return ONLY the complete, updated HTML email wrapped in \`\`\`html code blocks. Do not include any explanation.` };
  }
  return { prompt: `${promptWithKeys}\n\nIMPORTANT: Your response must contain ONLY the HTML email content wrapped in \`\`\`html code blocks.` };
}

function getLLMConfig(body) {
  const provider = body.provider || process.env.LLM_PROVIDER || 'ollama';
  const envEndpoint = process.env.LLM_ENDPOINT || process.env.OLLAMA_ENDPOINT || 'http://127.0.0.1:11434';
  const model = body.model || process.env.LLM_MODEL || 'llama3.1';
  const endpoint = body.endpoint || envEndpoint;
  let options = body.options;
  if (!options && process.env.LLM_OPTIONS) { try { options = JSON.parse(process.env.LLM_OPTIONS); } catch (_) { options = {}; } }
  return { provider, model, endpoint, options: options || {} };
}

function writeHtmlWithArchive(outputPath, html, runLogPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (fs.existsSync(outputPath)) {
    const dir = path.dirname(outputPath);
    const baseName = path.basename(outputPath, '.html');
    let n = 1; let candidate;
    do { candidate = path.join(dir, `${baseName}-${n}.html`); n++; } while (fs.existsSync(candidate));
    fs.renameSync(outputPath, candidate);
    appendLogLocal(`[INFO] Archived existing email.html to ${path.basename(candidate)}`, runLogPath);
  }
  appendLogLocal(`[PROGRESS] Generating HTML file: ${outputPath}`, runLogPath);
  appendLogLocal(`[CONTENT] HTML file content:\n${html}`, runLogPath);
  fs.writeFileSync(outputPath, html, 'utf8');
  appendLogLocal(`[PROGRESS] HTML email generated: ${outputPath}`, runLogPath);
}

function buildRecipients(base) {
  function toArray(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.filter(Boolean);
    if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
    return [];
  }
  const toList = toArray(base.to);
  const ccList = toArray(base.cc);
  let bccList = toArray(base.bcc);
  if (!toList.length && !ccList.length && !bccList.length) bccList = Array.isArray(base.RECIPIENTS) ? base.RECIPIENTS : [];
  return { toList, ccList, bccList };
}

function materializeHtmlForSend(body, ctx) {
  if (!body.html) return undefined;
  const fname = `email-${Date.now()}.html`;
  if (ctx.paths) {
    const p = path.join(ctx.paths.tmp, fname);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body.html, 'utf8');
    return p;
  }
  const rel = path.join('outputs', 'tmp', fname);
  const abs = path.join(REPO_ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body.html, 'utf8');
  return rel;
}

function absoluteFromMaybeInstance(relOrAbs, ctx) {
  if (path.isAbsolute(relOrAbs)) return relOrAbs;
  return ctx.paths ? path.join(ctx.paths.root, relOrAbs) : path.join(REPO_ROOT, relOrAbs);
}

async function generateEmailFlow(body) {
  const ctx = resolveContext(body, { activate: true });
  if (ctx.error) return { error: ctx.error, ctx, base: ctx.base };
  const base = ctx.base;
  const promptPath = resolvePromptPath(body, base, ctx);
  const promptText = body.promptText || fs.readFileSync(promptPath, 'utf8');
  const prep = preparePromptText(promptText, body, base, ctx);
  if (prep.error) return { errorObj: prep.error, ctx, base };
  const { provider, model, endpoint, options } = getLLMConfig(body);
  appendLogLocal('[INFO] Prompt prepared', ctx.paths ? ctx.paths.runLog : undefined);
  appendLogLocal('--- Prompt Start ---', ctx.paths ? ctx.paths.runLog : undefined);
  appendLogLocal(prep.prompt, ctx.paths ? ctx.paths.runLog : undefined);
  appendLogLocal('--- Prompt End ---', ctx.paths ? ctx.paths.runLog : undefined);
  const { html } = await generateHtml({ provider, model, endpoint, prompt: prep.prompt, options });
  agent_log({ message: `completed generating email by ${model}`, config: normalizeConfig(base), runLogOverride: ctx.paths ? ctx.paths.runLog : undefined });
  const htmlOutputRel = resolveOutputPathRel(body, base, ctx);
  const outputPath = absoluteFromMaybeInstance(htmlOutputRel, ctx);
  writeHtmlWithArchive(outputPath, html, ctx.paths ? ctx.paths.runLog : undefined);
  return { html, htmlOutputRel, outputPath, base, ctx };
}

async function sendEmailFlow(body, baseMaybe, ctxMaybe, overrideHtml) {
  const ctx = ctxMaybe || resolveContext(body, { activate: false });
  const base = baseMaybe || ctx.base;
  let htmlPath = body.htmlPath;
  if (!htmlPath && body.html) htmlPath = materializeHtmlForSend(body, ctx);
  if (!htmlPath && ctx.paths && ctx.paths.artifacts) htmlPath = path.join(ctx.paths.artifacts, 'email.html');
  if (!htmlPath && !overrideHtml) return { error: 'missing_html_or_htmlPath' };
  const html = overrideHtml || (htmlPath ? fs.readFileSync(absoluteFromMaybeInstance(htmlPath, ctx), 'utf8') : '');
  const subject = body.subject || base.EMAIL_SUBJECT;
  const fromEmail = body.senderEmail || base.SENDER_EMAIL;
  const fromName = body.senderName || base.SENDER_NAME;
  const { toList, ccList, bccList } = buildRecipients(base);
  let toFinal = toList, ccFinal = ccList, bccFinal = bccList;
  if (!toFinal.length && !ccFinal.length && !bccFinal.length) { toFinal = [fromEmail]; ccFinal = []; bccFinal = Array.isArray(base.RECIPIENTS) ? base.RECIPIENTS : []; }
  appendLogLocal(`[PROGRESS] Sending email. to=${toFinal.join(', ')} cc=${ccFinal.join(', ')} bcc=${bccFinal.join(', ')}`,
    ctx.paths ? ctx.paths.runLog : undefined);
  const data = await sendEmail({ fromName, fromEmail, to: toFinal.length ? toFinal : [fromEmail], cc: ccFinal, bcc: bccFinal, subject, html });
  agent_log({ message: `completed sending email to ${toFinal.length + ccFinal.length + bccFinal.length} recipients`, config: normalizeConfig(base), runLogOverride: ctx.paths ? ctx.paths.runLog : undefined });
  return { id: data.id, ctx, base };
}

async function handleGenerate(req, res, body) {
  try {
    const gen = await generateEmailFlow(body);
    if (gen.error) {
      const { base, ctx } = gen;
      if (ctx && ctx.paths) {
        agent_log({ message: gen.error, config: normalizeConfig(base || {}), runLogOverride: ctx.paths.runLog });
        agent_log({ message: 'state - abort', config: normalizeConfig(base || {}), runLogOverride: ctx.paths.runLog });
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: gen.error }));
      return;
    }
    if (gen.errorObj) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: gen.errorObj.code, path: gen.errorObj.path }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ htmlPath: gen.htmlOutputRel, html: gen.html }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}


// Helper to normalize config for logger (handles amp_logger as object or string)
function normalizeConfig(cfg) {
  return cfg || {};
}

async function handleSend(req, res, body) {
  try {
    const ctx = resolveContext(body, { activate: false });
    if (ctx.error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: ctx.error }));
      return;
    }
    const base = ctx.base;
    const sent = await sendEmailFlow(body, base, ctx);
    if (sent.error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: sent.error }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: sent.id }));
    // finalize state
    if (ctx.paths) {
      const metaPath = path.join(ctx.paths.root, 'meta.json');
      const metaErr = updateMetaJson(metaPath, 'finished');
      if (metaErr) {
        agent_log({ message: `meta.json error: ${metaErr}`, config: normalizeConfig(base), runLogOverride: ctx.paths.runLog });
        agent_log({ message: 'state - abort', config: normalizeConfig(base), runLogOverride: ctx.paths.runLog });
        return;
      }
      agent_log({ message: 'state - finished', config: normalizeConfig(base), runLogOverride: ctx.paths.runLog });
    } else {
      agent_log({ message: 'state - finished', config: normalizeConfig(base) });
    }
  } catch (e) {
    console.log('[ERROR] handleSend exception:', e);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.stack || e.message }));
  }
}

async function handleGenerateSend(req, res, body) {
  try {
    const gen = await generateEmailFlow(body);
    if (gen.error) {
      const { base, ctx } = gen;
      if (ctx && ctx.paths) {
        agent_log({ message: gen.error, config: normalizeConfig(base || {}), runLogOverride: ctx.paths.runLog });
        agent_log({ message: 'state - abort', config: normalizeConfig(base || {}), runLogOverride: ctx.paths.runLog });
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: gen.error }));
      return;
    }
    if (gen.errorObj) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: gen.errorObj.code, path: gen.errorObj.path }));
      return;
    }
    const sent = await sendEmailFlow(body, gen.base, gen.ctx, gen.html);
    if (sent.error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: sent.error }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, htmlPath: gen.htmlOutputRel, id: sent.id }));
    // finalize state for instances
    if (gen.ctx && gen.ctx.paths) {
      const metaPath = path.join(gen.ctx.paths.root, 'meta.json');
      const metaErr = updateMetaJson(metaPath, 'finished');
      if (metaErr) {
        agent_log({ message: `meta.json error: ${metaErr}`, config: normalizeConfig(gen.base), runLogOverride: gen.ctx.paths.runLog });
        agent_log({ message: 'state - abort', config: normalizeConfig(gen.base), runLogOverride: gen.ctx.paths.runLog });
        return;
      }
      agent_log({ message: 'state - finished', config: normalizeConfig(gen.base), runLogOverride: gen.ctx.paths.runLog });
    } else {
      agent_log({ message: 'state - finished', config: normalizeConfig(gen.base) });
    }
  } catch (e) {
    console.log('[ERROR] handleGenerateSend exception:', e);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.stack || e.message }));
  }
}

const server = http.createServer(async (req, res) => {
  // Allow cross-origin requests from AMP frontend
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  } catch (_) {}

  const parsed = url.parse(req.url, true);
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    try { res.writeHead(204); } catch (_) {}
    res.end();
    return;
  }

  if (method === 'GET' && parsed.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'POST' && (parsed.pathname === '/api/email-agent/generate' || parsed.pathname === '/api/email-agent/send' || parsed.pathname === '/api/email-agent/generate-send')) {
    let body = {};
    try { body = await readJsonBody(req); } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_json' }));
      return;
    }

    if (parsed.pathname === '/api/email-agent/generate') return handleGenerate(req, res, body);
    if (parsed.pathname === '/api/email-agent/send') return handleSend(req, res, body);
    if (parsed.pathname === '/api/email-agent/generate-send') return handleGenerateSend(req, res, body);
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Email agent REST server listening on http://localhost:${PORT}`);
});
