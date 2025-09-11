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

// Helper to resolve all paths based on instance_path or fallback to project root
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

function writeTempPrompt(promptText) {
  const fname = `prompt-${Date.now()}.txt`;
  const p = path.join(TMP_DIR, fname);
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

async function handleGenerate(req, res, body) {
  try {
    // Instance path logic
    const instancePath = body.instance_path;
    let paths, base;
    if (instancePath) {
      console.log('[DEBUG] instancePath:', instancePath);
      paths = resolveAgentPaths(instancePath);
      //console.log('[DEBUG] resolved paths:', paths);
      base = loadConfig(paths.config);
      fs.mkdirSync(paths.logs, { recursive: true });
      fs.mkdirSync(paths.artifacts, { recursive: true });
      // Update meta.json for state active
      const metaPath = require('path').join(paths.root, 'meta.json');
      const metaErr = updateMetaJson(metaPath, 'active');
      if (metaErr) {
        agent_log({ message: `meta.json error: ${metaErr}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
        agent_log({ message: 'state - abort', config: normalizeConfig(base), runLogOverride: paths.runLog });
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `meta.json error: ${metaErr}` }));
        return;
      }
      // Log agent state - active
      agent_log({ message: 'state - active', config: normalizeConfig(base), runLogOverride: paths.runLog });
      // Log instance folder path
      appendLogLocal(`instance folder: ${paths.root}`);
      // Error check: instance_id in config must match last part of instancePath
      if (base.instance_id) {
        const lastPart = require('path').basename(paths.root);
        if (lastPart !== base.instance_id) {
          const errMsg = `instance_id mismatch: config has '${base.instance_id}', folder is '${lastPart}'`;
          agent_log({ message: errMsg, config: normalizeConfig(base), runLogOverride: paths.runLog });
          agent_log({ message: 'state - abort', config: normalizeConfig(base), runLogOverride: paths.runLog });
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: errMsg }));
          return;
        }
      }
    } else {
      base = loadDefaultConfig();
      // Log agent state - active
      agent_log({ message: 'state - active', config: normalizeConfig(base) });
    }
    const promptPath = body.promptText ? writeTempPrompt(body.promptText) : (body.promptFile || base.PROMPT_FILE || path.join(REPO_ROOT, 'prompt.txt'));
    // Determine output path: for per-instance runs, always use artifacts/email.html unless htmlOutput is explicitly provided
    let htmlOutput;
    if (body.htmlOutput) {
      htmlOutput = body.htmlOutput;
    } else if (instancePath && paths && paths.artifacts) {
      htmlOutput = path.join(paths.artifacts, 'email.html');
    } else if (base.HTML_OUTPUT) {
      htmlOutput = base.HTML_OUTPUT;
    } else {
      htmlOutput = path.join('outputs', 'email.html');
    }
    const promptText = body.promptText || fs.readFileSync(path.isAbsolute(promptPath) ? promptPath : path.join(REPO_ROOT, promptPath), 'utf8');

    const userInstr = (body.instructions || '').trim();
    const keyInstrSection = buildKeyInstructionsSection(userInstr);
    const promptWithKeys = injectKeyInstructionsIntoPrompt(promptText, keyInstrSection);
    let enhancedPrompt;

    // If user provides instructions, try to apply them to an existing HTML (edit mode)
    if (userInstr) {
      // Prefer an explicitly provided source HTML path; else default to current email.html
      const srcPathRel = body.htmlPath || body.sourceHtmlPath || base.HTML_OUTPUT || path.join('outputs', 'email.html');
      const srcPath = path.isAbsolute(srcPathRel) ? srcPathRel : path.join(REPO_ROOT, srcPathRel);
      let baseHtml = '';
      if (fs.existsSync(srcPath)) {
        baseHtml = fs.readFileSync(srcPath, 'utf8');
      } else {
        // If user explicitly provided a path and it doesn't exist, error out; otherwise continue without baseHtml
        if (body.htmlPath || body.sourceHtmlPath) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'base_html_not_found', path: srcPathRel }));
          return;
        }
      }

      if (baseHtml) {
        enhancedPrompt = `${promptWithKeys}\n\nYou are updating an existing HTML email. Here is the current HTML to modify:\n\n\`\`\`html\n${baseHtml}\n\`\`\`\n\nIMPORTANT: Return ONLY the complete, updated HTML email wrapped in \`\`\`html code blocks. Do not include any explanation.`;
      } else {
        // No base HTML found; treat as fresh generation with key instructions injected
        enhancedPrompt = `${promptWithKeys}\n\nIMPORTANT: Your response must contain ONLY the HTML email content wrapped in \`\`\`html code blocks.`;
      }
    } else {
      // Original generation path (no extra instructions)
      enhancedPrompt = `${promptWithKeys}\n\nIMPORTANT: Your response must contain ONLY the HTML email content wrapped in \`\`\`html code blocks.`;
    }

    // LLM config: request overrides, then env only (no config.json)
    const provider = body.provider || process.env.LLM_PROVIDER || 'ollama';
    // Accept OLLAMA_ENDPOINT alias via env-to-env mapping
    const envEndpoint = process.env.LLM_ENDPOINT || process.env.OLLAMA_ENDPOINT || 'http://127.0.0.1:11434';
    const model = body.model || process.env.LLM_MODEL || 'llama3.1';
    const endpoint = body.endpoint || envEndpoint;
    let options = body.options;
    if (!options && process.env.LLM_OPTIONS) {
      try { options = JSON.parse(process.env.LLM_OPTIONS); } catch (e) { options = {}; }
    }
    options = options || {};

    // Log the effective prompt and LLM config for debugging adherence
    // Log prompt preparation (always include full content in local logs)
    appendLogLocal('[INFO] Prompt prepared', instancePath ? paths.runLog : undefined);
    appendLogLocal('--- Prompt Start ---', instancePath ? paths.runLog : undefined);
    appendLogLocal(enhancedPrompt, instancePath ? paths.runLog : undefined);
    appendLogLocal('--- Prompt End ---', instancePath ? paths.runLog : undefined);

  const { html } = await generateHtml({ provider, model, endpoint, prompt: enhancedPrompt, options });
  // Log completed generating email
  // Use model name from config or resolved model variable
  const modelName = model;
  agent_log({ message: `completed generating email by ${modelName}`, config: normalizeConfig(base) });

  const outputPath = path.isAbsolute(htmlOutput) ? htmlOutput : path.join(REPO_ROOT, htmlOutput);
  console.log('[DEBUG] htmlOutput (API response):', htmlOutput);
  console.log('[DEBUG] outputPath (actual file write):', outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  // If email.html exists, move it to email-1.html, email-2.html, etc.
  if (fs.existsSync(outputPath)) {
    const dir = path.dirname(outputPath);
    const baseName = path.basename(outputPath, '.html');
    let n = 1;
    let candidate;
    do {
      candidate = path.join(dir, `${baseName}-${n}.html`);
      n++;
    } while (fs.existsSync(candidate));
    fs.renameSync(outputPath, candidate);
    appendLogLocal(`[INFO] Archived existing email.html to ${path.basename(candidate)}`,
      instancePath ? paths.runLog : undefined);
  }
  // Log before writing new HTML
  appendLogLocal(`[PROGRESS] Generating HTML file: ${outputPath}`, instancePath ? paths.runLog : undefined);
  appendLogLocal(`[CONTENT] HTML file content:\n${html}`, instancePath ? paths.runLog : undefined);
  fs.writeFileSync(outputPath, html, 'utf8');
  appendLogLocal(`[PROGRESS] HTML email generated: ${outputPath}`, instancePath ? paths.runLog : undefined);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ htmlPath: htmlOutput, html }));
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
    const instancePath = body.instance_path;
    let paths, base;
    if (instancePath) {
      console.log('[DEBUG] instancePath:', instancePath);
      paths = resolveAgentPaths(instancePath);
      //console.log('[DEBUG] resolved paths:', paths);
      base = loadConfig(paths.config);
    } else {
      base = loadDefaultConfig();
    }
    let htmlPath = body.htmlPath;
    if (!htmlPath && body.html) {
      const fname = `email-${Date.now()}.html`;
      htmlPath = path.join('outputs', 'tmp', fname);
      fs.mkdirSync(path.dirname(path.join(REPO_ROOT, htmlPath)), { recursive: true });
      fs.writeFileSync(path.join(REPO_ROOT, htmlPath), body.html, 'utf8');
    }

    // Default to artifacts/email.html if instance_path is set and htmlPath is not provided
    if (!htmlPath && instancePath && paths && paths.artifacts) {
      htmlPath = path.join(paths.artifacts, 'email.html');
    }

    if (!htmlPath) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing_html_or_htmlPath' }));
      return;
    }

    const absoluteHtmlPath = path.isAbsolute(htmlPath) ? htmlPath : path.join(REPO_ROOT, htmlPath);
    const html = fs.readFileSync(absoluteHtmlPath, 'utf8');

    const subject = body.subject || base.EMAIL_SUBJECT;
    const fromEmail = body.senderEmail || base.SENDER_EMAIL;
    const fromName = body.senderName || base.SENDER_NAME;

    // Read recipients: prefer lowercase to/cc/bcc in config; fallback to RECIPIENTS -> bcc behavior
    function toArray(v) {
      if (!v) return [];
      if (Array.isArray(v)) return v.filter(Boolean);
      if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
      return [];
    }
    const toList = toArray(base.to);
    const ccList = toArray(base.cc);
    let bccList = toArray(base.bcc);
    if (!toList.length && !ccList.length && !bccList.length) {
      // Fallback to legacy RECIPIENTS as BCC
      bccList = Array.isArray(base.RECIPIENTS) ? base.RECIPIENTS : [];
    }

    // Determine final envelope: if any of to/cc/bcc provided, use them; else legacy behavior
    let toFinal = toList;
    let ccFinal = ccList;
    let bccFinal = bccList;
    if (!toFinal.length && !ccFinal.length && !bccFinal.length) {
      toFinal = [fromEmail];
      ccFinal = [];
      bccFinal = Array.isArray(base.RECIPIENTS) ? base.RECIPIENTS : [];
    }

    appendLogLocal(`[PROGRESS] Sending email. to=${toFinal.join(', ')} cc=${ccFinal.join(', ')} bcc=${bccFinal.join(', ')}`,
      instancePath ? paths.runLog : undefined);
    const data = await sendEmail({
      fromName,
      fromEmail,
      to: toFinal.length ? toFinal : [fromEmail],
      cc: ccFinal,
      bcc: bccFinal,
      subject,
      html,
    });
    // Log completed sending email to N recipients
    const nRecipients = (toFinal.length + ccFinal.length + bccFinal.length);
    agent_log({ message: `completed sending email to ${nRecipients} recipients`, config: normalizeConfig(base) });

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: data.id }));
    // Update meta.json for state finished
    if (instancePath) {
      const metaPath = require('path').join(paths.root, 'meta.json');
      const metaErr = updateMetaJson(metaPath, 'finished');
      if (metaErr) {
        agent_log({ message: `meta.json error: ${metaErr}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
        agent_log({ message: 'state - abort', config: normalizeConfig(base), runLogOverride: paths.runLog });
        return;
      }
      agent_log({ message: 'state - finished', config: normalizeConfig(base), runLogOverride: paths.runLog });
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
    // Generate first
    const instancePath = body.instance_path;
    const base = loadDefaultConfig();
    const promptPath = body.promptText ? writeTempPrompt(body.promptText) : (body.promptFile || base.PROMPT_FILE || path.join(REPO_ROOT, 'prompt.txt'));
    // Determine output path: per-instance artifacts/email.html if instance_path, else outputs/email.html
    let htmlOutput;
    if (body.htmlOutput) {
      htmlOutput = body.htmlOutput;
    } else if (base.HTML_OUTPUT) {
      htmlOutput = base.HTML_OUTPUT;
    } else if (instancePath) {
      const paths = resolveAgentPaths(instancePath);
      htmlOutput = path.join(paths.artifacts, 'email.html');
    } else {
      htmlOutput = path.join('outputs', 'email.html');
    }
    const promptText = body.promptText || fs.readFileSync(path.isAbsolute(promptPath) ? promptPath : path.join(REPO_ROOT, promptPath), 'utf8');
    const enhancedPrompt = `${promptText}\n\nIMPORTANT: Your response must contain ONLY the HTML email content wrapped in \`\`\`html code blocks.`;
    appendLogLocal('[INFO] Prompt prepared');
    appendLogLocal('--- Prompt Start ---');
    appendLogLocal(enhancedPrompt);
    appendLogLocal('--- Prompt End ---');

    // LLM config: request overrides, then env only (no config.json)
    const provider = body.provider || process.env.LLM_PROVIDER || 'ollama';
    const envEndpoint = process.env.LLM_ENDPOINT || process.env.OLLAMA_ENDPOINT || 'http://127.0.0.1:11434';
    const model = body.model || process.env.LLM_MODEL || 'llama3.1';
    const endpoint = body.endpoint || envEndpoint;
    const options = body.options || (process.env.LLM_OPTIONS ? (()=>{ try { return JSON.parse(process.env.LLM_OPTIONS); } catch { return {}; } })() : {});
    const { html } = await generateHtml({ provider, model, endpoint, prompt: enhancedPrompt, options });

    const outputPath = path.isAbsolute(htmlOutput) ? htmlOutput : path.join(REPO_ROOT, htmlOutput);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, html, 'utf8');
    appendLogLocal(`[PROGRESS] HTML email generated: ${outputPath}`);

    // Then send (use same to/cc/bcc logic as /send)
    const subject = body.subject || base.EMAIL_SUBJECT;
    const fromEmail = body.senderEmail || base.SENDER_EMAIL;
    const fromName = body.senderName || base.SENDER_NAME;

    function toArray(v) {
      if (!v) return [];
      if (Array.isArray(v)) return v.filter(Boolean);
      if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
      return [];
    }
    const toList = toArray(base.to);
    const ccList = toArray(base.cc);
    let bccList = toArray(base.bcc);
    if (!toList.length && !ccList.length && !bccList.length) {
      bccList = Array.isArray(base.RECIPIENTS) ? base.RECIPIENTS : [];
    }

    let toFinal = toList;
    let ccFinal = ccList;
    let bccFinal = bccList;
    if (!toFinal.length && !ccFinal.length && !bccFinal.length) {
      toFinal = [fromEmail];
      ccFinal = [];
      bccFinal = Array.isArray(base.RECIPIENTS) ? base.RECIPIENTS : [];
    }

    const pathsForLog = instancePath ? resolveAgentPaths(instancePath) : undefined;
    appendLogLocal(`[PROGRESS] Sending email. to=${toFinal.join(', ')} cc=${ccFinal.join(', ')} bcc=${bccFinal.join(', ')}`,
      pathsForLog ? pathsForLog.runLog : undefined);
    const data = await sendEmail({ fromName, fromEmail, to: toFinal.length ? toFinal : [fromEmail], cc: ccFinal, bcc: bccFinal, subject, html });

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, htmlPath: htmlOutput, id: data.id }));

    // Log completed sending email and agent state finished
    const nRecipients = (toFinal.length + ccFinal.length + bccFinal.length);
    agent_log({ message: `completed sending email to ${nRecipients} recipients`, config: normalizeConfig(base) });
    if (instancePath) {
      const metaPath = require('path').join(resolveAgentPaths(instancePath).root, 'meta.json');
      const metaErr = updateMetaJson(metaPath, 'finished');
      if (metaErr) {
        agent_log({ message: `meta.json error: ${metaErr}`, config: normalizeConfig(base), runLogOverride: pathsForLog ? pathsForLog.runLog : undefined });
        agent_log({ message: 'state - abort', config: normalizeConfig(base), runLogOverride: pathsForLog ? pathsForLog.runLog : undefined });
        return;
      }
      agent_log({ message: 'state - finished', config: normalizeConfig(base), runLogOverride: pathsForLog ? pathsForLog.runLog : undefined });
    } else {
      agent_log({ message: 'state - finished', config: normalizeConfig(base) });
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

  if (method === 'POST' && (parsed.pathname === '/api/email/generate' || parsed.pathname === '/api/email/send' || parsed.pathname === '/api/email/generate-send')) {
    let body = {};
    try { body = await readJsonBody(req); } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_json' }));
      return;
    }

    if (parsed.pathname === '/api/email/generate') return handleGenerate(req, res, body);
    if (parsed.pathname === '/api/email/send') return handleSend(req, res, body);
    if (parsed.pathname === '/api/email/generate-send') return handleGenerateSend(req, res, body);
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Email agent REST server listening on http://localhost:${PORT}`);
});
