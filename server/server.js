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
      throw new Error('meta.json not found');
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
const { agent_log } = require('./logger');

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
    const raw = fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8');
      const instancePath = body.instance_path;
      const paths = resolveAgentPaths(instancePath);
      const base = loadConfig(paths.config);
      // Ensure logs and artifacts subfolders exist
      fs.mkdirSync(paths.logs, { recursive: true });
      fs.mkdirSync(paths.artifacts, { recursive: true });
      // Log agent state - active
  } catch (e) {
    return {};
  }
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
  if (!instrSection) return promptText;
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
      agent_log({ message: `instance folder: ${paths.root}`, config: normalizeConfig(base), runLogOverride: paths.runLog });
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

    const llmCfg = base.llm || {};
    const provider = body.provider || llmCfg.provider || 'ollama';
    const model = body.model || llmCfg.model || 'llama3.1';
    const endpoint = body.endpoint || llmCfg.endpoint || 'http://127.0.0.1:11434';
    const options = body.options || llmCfg.options || {};

    // Log the effective prompt and LLM config for debugging adherence
    appendLog([
      'POST /api/email/generate',
      `provider=${provider} model=${model} endpoint=${endpoint}`,
      userInstr ? `instructions=${userInstr}` : 'instructions=<none>',
      keyInstrSection ? 'Injected [KEY INSTRUCTIONS] section.' : 'No [KEY INSTRUCTIONS] injected.',
      '--- Prompt Start ---',
      enhancedPrompt,
      '--- Prompt End ---'
    ]);

  const { html } = await generateHtml({ provider, model, endpoint, prompt: enhancedPrompt, options });
  // Log completed generating email
  // Use model name from config or resolved model variable
  const modelName = base.llm && base.llm.model ? base.llm.model : model;
  agent_log({ message: `completed generating email by ${modelName}`, config: normalizeConfig(base) });

  const outputPath = path.isAbsolute(htmlOutput) ? htmlOutput : path.join(REPO_ROOT, htmlOutput);
  console.log('[DEBUG] htmlOutput (API response):', htmlOutput);
  console.log('[DEBUG] outputPath (actual file write):', outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ htmlPath: htmlOutput, html }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}


// Helper to normalize config for logger (handles amp_logger as object or string)
function normalizeConfig(cfg) {
  const out = { ...cfg };
  if (cfg.amp_logger && typeof cfg.amp_logger === 'object' && cfg.amp_logger.log_folder_path) {
    out.amp_logger = cfg.amp_logger.log_folder_path;
  }
  return out;
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
    const recipients = Array.isArray(body.recipients) ? body.recipients : (base.RECIPIENTS || []);

    const data = await sendEmail({
      fromName,
      fromEmail,
      to: [fromEmail],
      bcc: recipients,
      subject,
      html,
    });
    // Log completed sending email to N recipients
    const nRecipients = (recipients && recipients.length) ? recipients.length : 0;
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
    console.log('[ERROR] handleGenerate exception:', e);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.stack || e.message }));
  }
}

async function handleGenerateSend(req, res, body) {
  try {
    // Generate first
    const genReq = { ...body };
    const base = loadDefaultConfig();
    const promptPath = body.promptText ? writeTempPrompt(body.promptText) : (body.promptFile || base.PROMPT_FILE || path.join(REPO_ROOT, 'prompt.txt'));
    // Determine output path: per-instance artifacts/email.html if instance_path, else outputs/email.html
    let htmlOutput;
    if (body.htmlOutput) {
      htmlOutput = body.htmlOutput;
    } else if (base.HTML_OUTPUT) {
      htmlOutput = base.HTML_OUTPUT;
    } else if (body.instance_path) {
      const paths = resolveAgentPaths(body.instance_path);
      htmlOutput = path.join(paths.artifacts, 'email.html');
    } else {
      htmlOutput = path.join('outputs', 'email.html');
    }
    const promptText = body.promptText || fs.readFileSync(path.isAbsolute(promptPath) ? promptPath : path.join(REPO_ROOT, promptPath), 'utf8');
    const enhancedPrompt = `${promptText}\n\nIMPORTANT: Your response must contain ONLY the HTML email content wrapped in \`\`\`html code blocks.`;

    const llmCfg = base.llm || {};
    const provider = body.provider || llmCfg.provider || 'ollama';
    const model = body.model || llmCfg.model || 'llama3.1';
    const endpoint = body.endpoint || llmCfg.endpoint || 'http://127.0.0.1:11434';
    const options = body.options || llmCfg.options || {};
    const { html } = await generateHtml({ provider, model, endpoint, prompt: enhancedPrompt, options });

    const outputPath = path.isAbsolute(htmlOutput) ? htmlOutput : path.join(REPO_ROOT, htmlOutput);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, html, 'utf8');

    // Then send
    const subject = body.subject || base.EMAIL_SUBJECT;
    const fromEmail = body.senderEmail || base.SENDER_EMAIL;
    const fromName = body.senderName || base.SENDER_NAME;
    const recipients = Array.isArray(body.recipients) ? body.recipients : (base.RECIPIENTS || []);
    const data = await sendEmail({ fromName, fromEmail, to: [fromEmail], bcc: recipients, subject, html });

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, htmlPath: htmlOutput, id: data.id }));
  } catch (e) {
    console.log('[ERROR] handleSend exception:', e);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.stack || e.message }));
  }
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const method = req.method || 'GET';

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
