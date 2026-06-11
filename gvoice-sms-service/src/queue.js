'use strict';
// FIFO for the shared Google Voice page. Playwright drives ONE page, so every
// operation (outbound send, inbox poll) must run alone — concurrent /send
// requests used to type over each other. Promise-chain = strict arrival order.
const log = require('./logger');

const MAX_DEPTH = parseInt(process.env.SEND_QUEUE_MAX || '10', 10);

let chain = Promise.resolve();
let depth = 0;

function queueDepth() { return depth; }

// Enqueue fn; resolves/rejects with fn's result once its turn completes.
// Rejects immediately with err.queueFull when the backlog is unreasonable —
// callers (Edge Functions) surface "busy, retry shortly" instead of hanging.
function enqueue(label, fn) {
  if (depth >= MAX_DEPTH) {
    const err = new Error(`Queue full (${depth} waiting) — try again shortly`);
    err.queueFull = true;
    return Promise.reject(err);
  }
  depth++;
  if (depth > 1) log.info(`"${label}" queued — position ${depth}`);
  const run = chain.then(fn);
  // next op waits for this one to settle either way; depth tracks the tail
  chain = run.then(() => {}, () => {}).then(() => { depth--; });
  return run;
}

module.exports = { enqueue, queueDepth };
