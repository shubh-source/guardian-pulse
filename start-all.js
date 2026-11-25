const { spawn } = require('node:child_process');
const path = require('node:path');

const PARENT_PORT = process.env.PARENT_PORT || '3001';
const CHILD_PORT = process.env.CHILD_PORT || '3002';

const parentProc = spawn(process.execPath, [path.join(__dirname, 'parent-app', 'server.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PARENT_PORT,
    CHILD_APP_URL: `http://localhost:${CHILD_PORT}`,
  },
});

const childProc = spawn(process.execPath, [path.join(__dirname, 'child-app', 'server.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CHILD_PORT,
    PARENT_API_URL: `http://127.0.0.1:${PARENT_PORT}`,
  },
});

function shutdown(signal) {
  if (!parentProc.killed) parentProc.kill(signal);
  if (!childProc.killed) childProc.kill(signal);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
