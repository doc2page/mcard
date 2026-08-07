import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken, safeEqualStr, requireAuth, parseCookies } from '../src/lib/auth.js';

test('signToken / verifyToken 合法 token 通过', () => {
  const t = signToken('secret');
  assert.equal(verifyToken(t, 'secret'), true);
});

test('verifyToken 错误密码拒绝', () => {
  const t = signToken('secret');
  assert.equal(verifyToken(t, 'wrong'), false);
});

test('verifyToken 过期拒绝', () => {
  const t = signToken('secret', -1000);
  assert.equal(verifyToken(t, 'secret'), false);
});

test('verifyToken 篡改签名拒绝', () => {
  const t = signToken('secret');
  assert.equal(verifyToken(t.slice(0, -2) + 'aa', 'secret'), false);
});

test('verifyToken 格式错误拒绝', () => {
  assert.equal(verifyToken('abc', 'secret'), false);
  assert.equal(verifyToken('', 'secret'), false);
  assert.equal(verifyToken(null, 'secret'), false);
});

test('safeEqualStr 定长比对', () => {
  assert.equal(safeEqualStr('abc', 'abc'), true);
  assert.equal(safeEqualStr('abc', 'abd'), false);
  assert.equal(safeEqualStr('abc', 'ab'), false);
});

test('parseCookies', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(null), {});
});

// requireAuth 中间件
function mockReq(p, cookie) {
  return { path: p, headers: cookie ? { cookie: cookie } : {} };
}
function mockRes() {
  return {
    redirected: null, statusVal: null, body: null,
    redirect(p) { this.redirected = p; },
    status(s) { this.statusVal = s; return { json: (b) => { this.body = b; } }; },
  };
}

test('requireAuth 白名单（/login）放行', () => {
  let nexted = false;
  const res = mockRes();
  requireAuth({ password: 'secret' })(mockReq('/login'), res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(res.redirected, null);
});

test('requireAuth 无 cookie 访问页面 → 302 /login', () => {
  const res = mockRes();
  requireAuth({ password: 'secret' })(mockReq('/'), res, () => {});
  assert.equal(res.redirected, '/login');
});

test('requireAuth 无 cookie 访问 API → 401', () => {
  const res = mockRes();
  requireAuth({ password: 'secret' })(mockReq('/api/state'), res, () => {});
  assert.equal(res.statusVal, 401);
  assert.equal(res.body.reason, 'auth_required');
});

test('requireAuth 无 cookie 访问 SSE → 401', () => {
  const res = mockRes();
  requireAuth({ password: 'secret' })(mockReq('/events'), res, () => {});
  assert.equal(res.statusVal, 401);
});

test('requireAuth 合法 cookie → next', () => {
  let nexted = false;
  const res = mockRes();
  const token = signToken('secret');
  requireAuth({ password: 'secret' })(mockReq('/api/state', 'mcard_token=' + token), res, () => { nexted = true; });
  assert.equal(nexted, true);
});
