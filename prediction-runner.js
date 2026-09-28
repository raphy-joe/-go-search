'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createLimiter, limitError } = require('./resource-limits');
const { validatePredictionSnapshot } = require('./prediction-engine');
const schedule = createLimiter({ concurrency: 2, maxQueue: 6, timeoutMs: 20000 });

async function runPrediction(input, options = {}) {
  validatePredictionSnapshot(input.snapshot);
  return schedule(signal => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const worker = new Worker(path.join(__dirname, 'prediction-worker.js'), {
      workerData: input, resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    let settled = false;
    const abort = () => finish(signal.reason || limitError('TIMEOUT', '计算超时，请重试', 504));
    function finish(error, result) {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      worker.terminate().finally(() => error ? reject(error) : resolve(result));
    }
    signal.addEventListener('abort', abort, { once: true });
    worker.on('message', message => finish(message.error ? Object.assign(new Error(message.error.message), message.error) : null, message.result));
    worker.on('error', error => finish(error));
    worker.on('exit', () => { if (!settled) finish(limitError('WORKER_EXIT', '计算未完成，请重试')); });
  }), options);
}
module.exports = { runPrediction };
