// src/lib/auth.js — 无状态 HMAC token + requireAuth 中间件（单用户访问鉴权）
// 启用条件：process.env.AUTH_PASSWORD 非空。token 不落库，重启仍有效（只要密码不变）。
import crypto from 'node:crypto';

export const AUTH_COOKIE = 'mcard_token';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;   // 30 天
export const AUTH_MAX_AGE_SEC = 30 * 24 * 60 * 60;
// 放行：登录页 + 登录接口 + 登录页静态资源 + health
const WHITELIST = ['/login', '/api/login', '/api/logout', '/login.html', '/login.css', '/logo.png', '/health'];

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function fromB64url(s) { return Buffer.from(s, 'base64url'); }
function hmac(password, data) {
  return crypto.createHmac('sha256', String(password)).update(data).digest();
}

// 签发 token：base64url({exp}) + '.' + base64url(hmac(password, payload))
export function signToken(password, maxAgeMs) {
  const exp = Date.now() + (maxAgeMs || MAX_AGE_MS);
  const payloadB64 = b64url(JSON.stringify({ exp: exp }));
  return payloadB64 + '.' + b64url(hmac(password, payloadB64));
}

// 校验 token：重算 hmac + 定长比对 + 检查 exp
export function verifyToken(token, password) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const payloadB64 = parts[0];
  const sig = fromB64url(parts[1]);
  const expected = hmac(password, payloadB64);
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(sig, expected)) return false;
  let payload;
  try { payload = JSON.parse(fromB64url(payloadB64).toString()); } catch (e) { return false; }
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return false;
  return true;
}

// 定长比对密码（防时序攻击）
export function safeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  String(header).split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

// requireAuth 中间件：白名单放行；其余验 cookie token，失败 → 页面 302 /login、API/SSE 401
export function requireAuth({ password }) {
  return function (req, res, next) {
    const p = req.path;
    if (WHITELIST.some(function (w) { return p === w || p.indexOf(w + '/') === 0; })) return next();
    const cookies = parseCookies(req.headers.cookie);
    if (verifyToken(cookies[AUTH_COOKIE], password)) return next();
    if (p.indexOf('/api/') === 0 || p === '/events') return res.status(401).json({ ok: false, reason: 'auth_required' });
    return res.redirect('/login');
  };
}
