import { EventEmitter } from 'events';
import type { Request, Response } from 'express';

const bus = new EventEmitter();
bus.setMaxListeners(100);

function broadcast(msg: unknown): void {
  bus.emit('message', msg);
}

// Subscribe to broadcast messages (e.g. the Electron tray). Returns an
// unsubscribe function. Keeps the raw EventEmitter internal to this module.
function subscribe(listener: (msg: unknown) => void): () => void {
  bus.on('message', listener);
  return () => bus.off('message', listener);
}

// Attaches an SSE stream to an express response.
function sse(req: Request, res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const onMessage = (msg: unknown) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
  bus.on('message', onMessage);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off('message', onMessage);
  });
}

export { broadcast, subscribe, sse };
