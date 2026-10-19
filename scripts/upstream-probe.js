'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const rawFetch = require('node-fetch');
const { limitedFetch } = require('../resource-limits');
const { fetchTextWithRetry } = require('../upstream-client');
const { probeUpstream } = require('../upstream-probe');

async function main() {
  const report = await probeUpstream({ fetchText: (url, options, retries) =>
    fetchTextWithRetry((url, options) => limitedFetch(rawFetch, url, options), url, options, retries) });
  const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
  if (output) {
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'failed' ? 2 : 0;
}
main().catch(error => { console.error(error.message); process.exitCode = 2; });
