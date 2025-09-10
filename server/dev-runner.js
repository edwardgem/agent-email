// Lightweight dev runner with auto-reload, no external deps
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const watchPaths = [
  path.join(__dirname),              // server/*.js
  path.join(__dirname, '..', 'config.json'),
  path.join(__dirname, '..', 'prompt.txt'),
];

let child = null;
let restarting = false;
let changeTimer = null;

function start() {
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (restarting) return; // expect exit during restart
    console.log(`Server exited with code ${code}${signal ? ` signal ${signal}` : ''}`);
  });
}

function restart() {
  if (restarting) return;
  restarting = true;
  if (child) {
    child.once('exit', () => {
      restarting = false;
      console.log('Restarting server...');
      start();
    });
    child.kill('SIGTERM');
    setTimeout(() => {
      if (restarting) {
        child.kill('SIGKILL');
      }
    }, 1500);
  } else {
    restarting = false;
    start();
  }
}

function queueRestart() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(restart, 200);
}

function watch(target) {
  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      fs.readdirSync(target).forEach((f) => {
        if (f.startsWith('.')) return;
        if (!f.endsWith('.js')) return;
        const p = path.join(target, f);
        fs.watch(p, { persistent: true }, queueRestart);
      });
      fs.watch(target, { persistent: true }, queueRestart);
    } else {
      fs.watch(target, { persistent: true }, queueRestart);
    }
  } catch (e) {
    // Ignore missing files at startup
  }
}

watchPaths.forEach(watch);
console.log('Starting server (dev auto-reload)...');
start();

