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

// Helper to update meta.json for agent state, with optional extra fields
function updateMetaJson(metaPath, state, updates) {
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
    if (updates && typeof updates === 'object') {
      Object.assign(meta, updates);
    }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    return null;
  } catch (e) {
    return e.message || String(e);
  }
}

// Append a progress entry [timestamp, message] to meta.json
function appendProgress(metaPath, message) {
  try {
    if (!fs.existsSync(metaPath)) {
      throw new Error(`meta.json not found at ${metaPath}`);
    }
    const raw = fs.readFileSync(metaPath, 'utf8');
    const meta = JSON.parse(raw);
    if (!Array.isArray(meta.progress)) meta.progress = [];
    meta.progress.push([formatDateYMDHMS(new Date()), String(message)]);
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

async function generateEmailFlow(body, ctxMaybe) {
  const ctx = ctxMaybe || resolveContext(body, { activate: true });
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
  // Progress: LLM generating email
  if (ctx.paths) appendProgress(path.join(ctx.paths.root, 'meta.json'), 'llm generating email');
  const { html } = await generateHtml({ provider, model, endpoint, prompt: prep.prompt, options });
  agent_log({ message: `completed generating email by ${model}`, config: normalizeConfig(base), runLogOverride: ctx.paths ? ctx.paths.runLog : undefined });
  // Progress: writing html output
  if (ctx.paths) appendProgress(path.join(ctx.paths.root, 'meta.json'), 'writing html output');
  const htmlOutputRel = resolveOutputPathRel(body, base, ctx);
  const outputPath = absoluteFromMaybeInstance(htmlOutputRel, ctx);
  writeHtmlWithArchive(outputPath, html, ctx.paths ? ctx.paths.runLog : undefined);
  // Progress: generated html
  if (ctx.paths) appendProgress(path.join(ctx.paths.root, 'meta.json'), 'generated html');
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
  // Progress: sending emails
  if (ctx.paths) appendProgress(path.join(ctx.paths.root, 'meta.json'), 'sending emails');
  const data = await sendEmail({ fromName, fromEmail, to: toFinal.length ? toFinal : [fromEmail], cc: ccFinal, bcc: bccFinal, subject, html });
  agent_log({ message: `completed sending email to ${toFinal.length + ccFinal.length + bccFinal.length} recipients`, config: normalizeConfig(base), runLogOverride: ctx.paths ? ctx.paths.runLog : undefined });
  // Progress: sent email
  if (ctx.paths) appendProgress(path.join(ctx.paths.root, 'meta.json'), 'sent email');
  return { id: data.id, ctx, base };
}

async function handleGenerate(req, res, body) {
  try {
    // Async mode: require instance_id and return 202 immediately after activation
    if (body && body.async === true) {
      if (!body.instance_id) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'async_requires_instance_id' }));
        return;
      }
      const baseFolder = process.env.AGENT_FOLDER;
      if (!baseFolder) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_env_AGENT_FOLDER' }));
        return;
      }
      const instancePath = path.join(baseFolder, body.instance_id);
      const paths = resolveAgentPaths(instancePath);
      fs.mkdirSync(paths.logs, { recursive: true });
      fs.mkdirSync(paths.artifacts, { recursive: true });
      const base = loadConfig(paths.config);
      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const metaPath = path.join(paths.root, 'meta.json');
      const metaErr = updateMetaJson(metaPath, 'active', { job_id: jobId, last_error: null });
      if (metaErr) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `meta.json error: ${metaErr}` }));
        return;
      }
      agent_log({ message: `state - active (async generate) job_id=${jobId}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
      // Return 202 Accepted with status link
      const statusUrl = `/api/email-agent/status?instance_id=${encodeURIComponent(body.instance_id)}`;
      res.writeHead(202, { 'content-type': 'application/json', Location: statusUrl });
      res.end(JSON.stringify({ accepted: true, status: 'active', instance_id: body.instance_id, job_id: jobId, links: { status: statusUrl } }));
      // Background task
      setImmediate(async () => {
        try {
          const ctx = { paths, base };
          const gen = await generateEmailFlow(body, ctx);
          if (gen.error || gen.errorObj) {
            const errMsg = gen.error || (gen.errorObj && `${gen.errorObj.code}${gen.errorObj.path ? ` (${gen.errorObj.path})` : ''}`) || 'unknown_error';
            agent_log({ message: `async generate error: ${errMsg}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
            const metaErr2 = updateMetaJson(metaPath, 'abort', { job_id: jobId, last_error: errMsg });
            if (metaErr2) agent_log({ message: `meta.json error: ${metaErr2}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
            agent_log({ message: 'state - abort', config: normalizeConfig(base), runLogOverride: paths.runLog });
            return;
          }
          const metaErr3 = updateMetaJson(metaPath, 'finished', { job_id: jobId, last_error: null, last_html_path: gen.htmlOutputRel });
          if (metaErr3) {
            agent_log({ message: `meta.json error: ${metaErr3}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
            agent_log({ message: 'state - abort', config: normalizeConfig(base), runLogOverride: paths.runLog });
            return;
          }
          agent_log({ message: 'state - finished', config: normalizeConfig(base), runLogOverride: paths.runLog });
        } catch (e) {
          agent_log({ message: `async generate exception: ${e.stack || e.message}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
          const metaErr4 = updateMetaJson(metaPath, 'abort', { job_id: jobId, last_error: String(e && (e.stack || e.message) || e) });
          if (metaErr4) agent_log({ message: `meta.json error: ${metaErr4}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
          agent_log({ message: 'state - abort', config: normalizeConfig(base), runLogOverride: paths.runLog });
        }
      });
      return;
    }
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
    // Async mode: require instance_id and return 202 immediately after activation
    if (body && body.async === true) {
      if (!body.instance_id) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'async_requires_instance_id' }));
        return;
      }
      const baseFolder = process.env.AGENT_FOLDER;
      if (!baseFolder) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_env_AGENT_FOLDER' }));
        return;
      }
      const instancePath = path.join(baseFolder, body.instance_id);
      const paths = resolveAgentPaths(instancePath);
      fs.mkdirSync(paths.logs, { recursive: true });
      fs.mkdirSync(paths.artifacts, { recursive: true });
      const base = loadConfig(paths.config);
      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const metaPath = path.join(paths.root, 'meta.json');
      const metaErr = updateMetaJson(metaPath, 'active', { job_id: jobId, last_error: null });
      if (metaErr) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `meta.json error: ${metaErr}` }));
        return;
      }
      agent_log({ message: `state - active (async send) job_id=${jobId}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
      const statusUrl = `/api/email-agent/status?instance_id=${encodeURIComponent(body.instance_id)}`;
      res.writeHead(202, { 'content-type': 'application/json', Location: statusUrl });
      res.end(JSON.stringify({ accepted: true, status: 'active', instance_id: body.instance_id, job_id: jobId, links: { status: statusUrl } }));
      setImmediate(async () => {
        try {
          const ctx = { paths, base };
          const sent = await sendEmailFlow(body, base, ctx);
          if (sent.error) {
            agent_log({ message: `async send error: ${sent.error}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
            const metaErr2 = updateMetaJson(metaPath, 'abort', { job_id: jobId, last_error: sent.error });
            if (metaErr2) agent_log({ message: `meta.json error: ${metaErr2}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
            agent_log({ message: 'state - abort', config: normalizeConfig(base), runLogOverride: paths.runLog });
            return;
          }
          const metaErr3 = updateMetaJson(metaPath, 'finished', { job_id: jobId, last_error: null, last_send_id: sent.id });
          if (metaErr3) {
            agent_log({ message: `meta.json error: ${metaErr3}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
            agent_log({ message: 'state - abort', config: normalizeConfig(base), runLogOverride: paths.runLog });
            return;
          }
          agent_log({ message: 'state - finished', config: normalizeConfig(base), runLogOverride: paths.runLog });
        } catch (e) {
          agent_log({ message: `async send exception: ${e.stack || e.message}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
          const metaErr4 = updateMetaJson(metaPath, 'abort', { job_id: jobId, last_error: String(e && (e.stack || e.message) || e) });
          if (metaErr4) agent_log({ message: `meta.json error: ${metaErr4}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
          agent_log({ message: 'state - abort', config: normalizeConfig(base), runLogOverride: paths.runLog });
        }
      });
      return;
    }
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
    // Async mode: require instance_id and return 202 immediately after activation
    if (body && body.async === true) {
      if (!body.instance_id) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'async_requires_instance_id' }));
        return;
      }
      const baseFolder = process.env.AGENT_FOLDER;
      if (!baseFolder) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_env_AGENT_FOLDER' }));
        return;
      }
      const instancePath = path.join(baseFolder, body.instance_id);
      const paths = resolveAgentPaths(instancePath);
      fs.mkdirSync(paths.logs, { recursive: true });
      fs.mkdirSync(paths.artifacts, { recursive: true });
      const base = loadConfig(paths.config);
      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const metaPath = path.join(paths.root, 'meta.json');
      const metaErr = updateMetaJson(metaPath, 'active', { job_id: jobId, last_error: null });
      if (metaErr) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `meta.json error: ${metaErr}` }));
        return;
      }
      agent_log({ message: `state - active (async generate-send) job_id=${jobId}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
      const statusUrl = `/api/email-agent/status?instance_id=${encodeURIComponent(body.instance_id)}`;
      res.writeHead(202, { 'content-type': 'application/json', Location: statusUrl });
      res.end(JSON.stringify({ accepted: true, status: 'active', instance_id: body.instance_id, job_id: jobId, links: { status: statusUrl } }));
      setImmediate(async () => {
        try {
          const ctx = { paths, base };
          const gen = await generateEmailFlow(body, ctx);
          if (gen.error || gen.errorObj) {
            const errMsg = gen.error || (gen.errorObj && `${gen.errorObj.code}${gen.errorObj.path ? ` (${gen.errorObj.path})` : ''}`) || 'unknown_error';
            agent_log({ message: `async generate-send (generate) error: ${errMsg}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
            const metaErr2 = updateMetaJson(metaPath, 'abort', { job_id: jobId, last_error: errMsg });
            if (metaErr2) agent_log({ message: `meta.json error: ${metaErr2}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
            agent_log({ message: 'state - abort', config: normalizeConfig(base), runLogOverride: paths.runLog });
            return;
          }
          const sent = await sendEmailFlow(body, base, ctx, gen.html);
          if (sent.error) {
            agent_log({ message: `async generate-send (send) error: ${sent.error}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
            const metaErr3 = updateMetaJson(metaPath, 'abort', { job_id: jobId, last_error: sent.error, last_html_path: gen.htmlOutputRel });
            if (metaErr3) agent_log({ message: `meta.json error: ${metaErr3}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
            agent_log({ message: 'state - abort', config: normalizeConfig(base), runLogOverride: paths.runLog });
            return;
          }
          const metaErr4 = updateMetaJson(metaPath, 'finished', { job_id: jobId, last_error: null, last_html_path: gen.htmlOutputRel, last_send_id: sent.id });
          if (metaErr4) {
            agent_log({ message: `meta.json error: ${metaErr4}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
            agent_log({ message: 'state - abort', config: normalizeConfig(base), runLogOverride: paths.runLog });
            return;
          }
          agent_log({ message: 'state - finished', config: normalizeConfig(base), runLogOverride: paths.runLog });
        } catch (e) {
          agent_log({ message: `async generate-send exception: ${e.stack || e.message}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
          const metaErr5 = updateMetaJson(metaPath, 'abort', { job_id: jobId, last_error: String(e && (e.stack || e.message) || e) });
          if (metaErr5) agent_log({ message: `meta.json error: ${metaErr5}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
          agent_log({ message: 'state - abort', config: normalizeConfig(base), runLogOverride: paths.runLog });
        }
      });
      return;
    }
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

  // Status endpoint: returns meta.json contents for an instance
  if (method === 'GET' && parsed.pathname === '/api/email-agent/status') {
    const instanceId = parsed.query && parsed.query.instance_id;
    if (!instanceId) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing_instance_id' }));
      return;
    }
    const baseFolder = process.env.AGENT_FOLDER;
    if (!baseFolder) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing_env_AGENT_FOLDER' }));
      return;
    }
    const instancePath = path.join(baseFolder, instanceId);
    const metaPath = path.join(instancePath, 'meta.json');
    try {
      const raw = fs.readFileSync(metaPath, 'utf8');
      const meta = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ instance_id: instanceId, ...meta }));
    } catch (e) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `meta_not_found_or_invalid: ${e.message}` }));
    }
    return;
  }

  // Progress endpoint: returns only the progress array for an instance
  if (method === 'GET' && parsed.pathname === '/api/email-agent/progress') {
    const instanceId = parsed.query && parsed.query.instance_id;
    if (!instanceId) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing_instance_id' }));
      return;
    }
    const baseFolder = process.env.AGENT_FOLDER;
    if (!baseFolder) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing_env_AGENT_FOLDER' }));
      return;
    }
    const instancePath = path.join(baseFolder, instanceId);
    const metaPath = path.join(instancePath, 'meta.json');
    try {
      const raw = fs.readFileSync(metaPath, 'utf8');
      const meta = JSON.parse(raw);
      const progress = Array.isArray(meta.progress) ? meta.progress : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ instance_id: instanceId, progress }));
    } catch (e) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `meta_not_found_or_invalid: ${e.message}` }));
    }
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
