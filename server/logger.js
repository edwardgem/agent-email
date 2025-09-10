// logger.js
// Agent logging utility for agent-email project



const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const LOG_API_URL = process.env.LOG_API_URL || 'http://localhost:4000/api/log';



// Helper to append log to local run.log
function appendLogLocal(message, runLogOverride) {
  try {
    const stamp = new Date().toISOString();
    const logLine = `[${stamp}] ${message}\n`;
    // If runLogOverride is provided (per-instance), use it; else use project logs/run.log
    const logPath = runLogOverride || path.resolve(__dirname, '../logs/run.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, logLine);
  } catch (e) {
    // Fallback: print to console if file write fails
    console.error('[agent_log local] Failed to write log:', e);
  }
}

// Main agent_log function: log to REST API and local run.log
async function agent_log({ message, config, level = 'info', meta = {}, service = 'agent-email', runLogOverride }) {
  if (!message || !config) return;
  const instanceId = config.instance_id || 'unknown-instance';
  // Always log locally
  appendLogLocal(message, runLogOverride);
  // Also send to REST API
  try {
    await fetch(LOG_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service,
        level,
        message,
        timestamp: new Date().toISOString(),
        meta: { ...meta, instance_id: instanceId }
      })
    });
  } catch (e) {
    // Log REST errors locally as well
    appendLogLocal(`[agent_log REST] Failed to log: ${e}`, runLogOverride);
    console.error('[agent_log REST] Failed to log:', e);
  }
}

module.exports = { agent_log, appendLogLocal };
