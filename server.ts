import path from 'node:path';
import dotenv from 'dotenv';
import { createApp } from './server/app.ts';
import { Store } from './server/db.ts';

dotenv.config({ quiet: true });

// Producción = NODE_ENV=production o la bandera --prod (npm start la incluye).
const isProd = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.cwd(), process.env.DATA_DIR || '.data');

function log(message: string, meta?: Record<string, unknown>): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (meta) console.warn(line, JSON.stringify(meta));
  else console.warn(line);
}

async function startServer() {
  const store = await Store.open({ dir: DATA_DIR, isProd, log });
  const { app } = await createApp(store, { isProd, log });

  // Limpieza periódica de sesiones vencidas.
  setInterval(
    () => {
      if (store.purgeExpiredSessions()) store.save();
    },
    60 * 60 * 1000
  ).unref();

  const server = app.listen(PORT, HOST, () => {
    console.log(`CreciSano (${isProd ? 'producción' : 'desarrollo'}) en http://${HOST}:${PORT}`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('unhandledRejection', (reason) => {
    log('unhandledRejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });
}

startServer().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
