import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createState } from '../src/state.js';
import { createSseRouter } from '../src/routes/sse.js';

function fakeStore() { let s = null; return { loadState: () => s, saveState: (x) => { s = x; } }; }

test('state.update 触发 SSE 事件', async () => {
  const state = createState({ store: fakeStore() });
  const app = express(); app.use(createSseRouter({ state }));
  const server = app.listen(0);
  const port = server.address().port;
  const p = new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/events', headers: { accept: 'text/event-stream' } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c.toString(); if (buf.includes('\n\n')) resolve(buf); });
    });
  });
  await new Promise((r) => setTimeout(r, 50));
  await state.update({ profile: { id: 1 } });
  const buf = await p;
  assert.ok(buf.includes('event: state'));
  assert.ok(buf.includes('"profile"'));
  server.close();
});
