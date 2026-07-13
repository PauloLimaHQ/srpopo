const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(100);

function broadcast(msg) {
  bus.emit('message', msg);
}

// Attaches an SSE stream to an express response.
function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const onMessage = (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
  bus.on('message', onMessage);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off('message', onMessage);
  });
}

module.exports = { broadcast, sse };
