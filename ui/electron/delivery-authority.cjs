'use strict';
// Read-only delivery inspection shares the desktop's actual source/approval
// boundary. No adapter is imported, and no job or publication state is changed.
const { secureReadProjectFile, rebuildAuthoritativePublicationRequest } = require('./publication-authority.cjs');
async function inspectDeliveryAuthority(projectDir, runId, queuePath) {
  const file = await secureReadProjectFile(projectDir, queuePath);
  const queue = JSON.parse(file.buffer.toString('utf8'));
  if (!Array.isArray(queue.target_platforms) || !Array.isArray(queue.jobs) || !queue.jobs.length || queue.jobs.length > 3) {
    throw new Error('当前交付必须使用已选平台的原生草稿队列。');
  }
  const files = new Map([[queuePath, file.sha256]]);
  let authority;
  for (const job of queue.jobs) {
    const result = await rebuildAuthoritativePublicationRequest({ projectDir, forDelivery: true,
      request: { runId, queuePath, jobId: job.job_id, expectedPayloadHash: job.payload_hash } });
    if (authority && JSON.stringify(authority) !== JSON.stringify(result.authorityContract)) throw new Error('核验期间素材或任务发生变化，请重试。');
    authority = result.authorityContract;
    for (const [path, verified] of result.verifiedFiles) files.set(path, verified.sha256);
  }
  const after = await secureReadProjectFile(projectDir, queuePath);
  if (after.sha256 !== file.sha256) throw new Error('核验期间发布信息发生变化，请重试。');
  return { authority, files: Object.fromEntries(files) };
}
module.exports = { inspectDeliveryAuthority };
if (require.main === module) {
  const [projectDir, runId, queuePath] = process.argv.slice(2);
  inspectDeliveryAuthority(projectDir, runId, queuePath).then((result) => process.stdout.write(JSON.stringify(result)))
    .catch((error) => { process.stdout.write(JSON.stringify({ error: error.message, code: error.code || 'delivery_authority_invalid' })); process.exitCode = 1; });
}
