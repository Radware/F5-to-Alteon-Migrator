'use strict';
// Runs one conversion off the server's main thread. migrate() is synchronous,
// so doing this inline would block /healthz for the whole conversion and let
// Kubernetes restart the pod mid-job.
const { parentPort, workerData } = require('worker_threads');
const { migrate, outputFiles } = require('./index');
const { resolveInput } = require('./extract');

async function run({ file, rdMode, maxConfigBytes }) {
  const resolved = await resolveInput(file, { maxConfigBytes }).catch((e) => { e.status = 422; throw e; });
  const res = migrate(resolved.map(s => s.text), { rdMode, partitions: resolved.partitions || [] });
  if (res.objectCount === 0) {
    throw Object.assign(new Error('no F5 configuration objects found'), { status: 422 });
  }
  const files = outputFiles(res);
  files['summary.json'] = JSON.stringify({
    converted: res.summary,
    manual: res.diagnostics.filter(d => d.sev === 'log1').length,
    unsupported: res.diagnostics.filter(d => d.sev === 'log2').length,
    notes: resolved.notes || []
  }, null, 2) + '\n';
  return files;
}

run(workerData).then(
  (files) => parentPort.postMessage({ files }),
  // the temp path means nothing to the caller
  (e) => parentPort.postMessage({ status: e.status || 500, error: e.message.split(workerData.file).join('upload') })
);
