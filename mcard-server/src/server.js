// src/server.js
import express from 'express';
import { fileURLToPath } from 'node:url';

export function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  return app;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log('[mcard] listening on ' + port));
}
