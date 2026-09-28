'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { predictPlayerRank } = require('./prediction-engine');
try {
  parentPort.postMessage({ result: predictPlayerRank(workerData) });
} catch (error) {
  parentPort.postMessage({ error: { message: error.message, code: error.code, status: error.status } });
}
