// src/routes/auth.js — 登录页 + /api/login + /api/logout
import { Router } from 'express';
import path from 'node:path';
import { signToken, safeEqualStr, AUTH_COOKIE, AUTH_MAX_AGE_SEC } from '../lib/auth.js';

export function createAuthRouter({ password, publicDir }) {
  const router = Router();
  router.get('/login', (_req, res) => res.sendFile(path.join(publicDir, 'login.html')));
  router.post('/api/login', (req, res) => {
    const pw = String((req.body && req.body.password) || '');
    if (!safeEqualStr(pw, password)) return res.status(401).json({ ok: false });
    const token = signToken(password);
    const cookie = AUTH_COOKIE + '=' + token + '; HttpOnly; SameSite=Lax; Max-Age=' + AUTH_MAX_AGE_SEC + '; Path=/';
    res.setHeader('Set-Cookie', cookie);
    res.json({ ok: true });
  });
  router.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', AUTH_COOKIE + '=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/');
    res.json({ ok: true });
  });
  return router;
}
