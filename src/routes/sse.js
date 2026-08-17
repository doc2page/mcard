// src/routes/sse.js
import { Router } from 'express';

export function createSseRouter({ state }) {
  const router = Router();
  router.get('/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    const send = (evt) => res.write('event: ' + evt.type + '\ndata: ' + JSON.stringify(evt) + '\n\n');
    const unsubscribe = state.subscribe(send);
    // 30s 心跳注释行：防 NAT/反向代理 idle 超时静默掐断长连接（半开连接客户端无感知，patch 会静默丢失）
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) { /* 连接已断 */ } }, 30000);
    req.on('close', () => { clearInterval(hb); unsubscribe(); });
  });
  return router;
}
