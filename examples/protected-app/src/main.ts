import { createApp } from './app.js';
import { loadConfig } from './config.js';

process.umask(0o077);
const config = loadConfig();
const app = createApp(config);
app.server.listen(config.port, config.host, () => {
  console.log(`Draftroom is listening at ${config.origin}. Demo credentials: ${config.dataDir}/accounts.json`);
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 30_000);
  deadline.unref();
  void app.close().then(() => { clearTimeout(deadline); process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
});
