const path = require('node:path');
const { createApp } = require('../server/app');

const PORT = Number(process.env.PARENT_PORT || process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'guardian.db');
const CHILD_APP_URL = process.env.CHILD_APP_URL || 'http://localhost:3002';

const { server, close } = createApp({
  dbPath: DB_PATH,
  publicDir: path.join(__dirname, 'public'),
});

server.listen(PORT, HOST, () => {
  console.log(`GuardianPulse PARENT App running at http://localhost:${PORT}`);
  console.log(`  Pair Child devices using the separate Child App at ${CHILD_APP_URL}`);
});

function shutdown() {
  console.log('\nShutting down GuardianPulse Parent App...');
  close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
