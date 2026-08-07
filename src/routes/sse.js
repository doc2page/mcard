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
    req.on('close', () => unsubscribe());
  });
  return router;
}
