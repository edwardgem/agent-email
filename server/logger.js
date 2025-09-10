// logger.js
// Agent logging utility for agent-email project

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const lockfile = require('proper-lockfile');

// Helper to get formatted date for amp log filename (e.g., amp-sep-2025.log)
function getAmpLogFilename() {
  const now = new Date();
  const month = now.toLocaleString('en-US', { month: 'short' }).toLowerCase();
  const year = now.getFullYear();
  return `amp-${month}-${year}.log`;
}

// Helper to get timestamp string in required format
function getAgentTimestamp() {
  return new Date().toString().replace(/ GMT.*$/, ''); // e.g. Mon Sep 1 09:30:00 PDT 2025
}

// Main agent_log function
async function agent_log({ message, config }) {
  if (!message || !config) return;
  const instanceId = config.instance_id || 'unknown-instance';
  const ampLoggerPath = config.amp_logger || 'logs';
  const repoRoot = path.resolve(__dirname, '..');
  const ampLogDir = path.isAbsolute(ampLoggerPath) ? ampLoggerPath : path.join(repoRoot, ampLoggerPath);
  const ampLogFile = path.join(ampLogDir, getAmpLogFilename());
  // Allow override of run.log location (for per-instance logs)
  const runLogFile = arguments[0].runLogOverride || path.join(repoRoot, 'logs', 'run.log');

  const logLine = `${getAgentTimestamp()}: [${instanceId}] ${message}`;

  // Ensure amp log dir exists
  fs.mkdirSync(ampLogDir, { recursive: true });

  // Write to run.log (no lock)
  fs.appendFileSync(runLogFile, logLine + '\n');

  // Write to amp log with file lock
  let release;
  try {
    release = await lockfile.lock(ampLogFile, { retries: 3, stale: 5000 });
    fs.appendFileSync(ampLogFile, logLine + '\n');
  } catch (e) {
    // If lock fails, fallback: still try to write (may race)
    fs.appendFileSync(ampLogFile, logLine + '\n');
  } finally {
    if (release) await release();
  }
}

module.exports = { agent_log };
