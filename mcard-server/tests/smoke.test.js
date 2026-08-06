import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createServer } from '../src/server.js';

function req(server, method, p, body) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : {} }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

test('装配后 health + state + collect(unknown) 可用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcard-'));
  const { server } = createServer({ dbPath: path.join(dir, 's.db'), port: 0 });
  await new Promise((r) => server.once('listening', r));  // 绑定到显式 host 时 address() 在 listening 前为 null
  try {
    const h = await req(server, 'GET', '/health');
    assert.equal(h.json.ok, true);
    const s = await req(server, 'GET', '/api/state');
    assert.ok(s.json.config);
    const c = await req(server, 'POST', '/api/collect', { type: 'nope' });
    assert.equal(c.json.reason, 'unknown_type');
  } finally { server.close(); }
});
