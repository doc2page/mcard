// tests/health.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import http from 'node:http';

function getJson(server, path) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + port + path, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body || '{}') }));
    }).on('error', reject);
  });
}

test('GET /health returns ok', async () => {
  const server = createApp().listen(0);
  try {
    const r = await getJson(server, '/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  } finally { server.close(); }
});
