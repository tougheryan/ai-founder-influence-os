import { access, appendFile, mkdir, rm } from 'node:fs/promises';
import { withProjectWriteLock } from './write-guard';

const label = process.env.AIFIOS_LOCK_TEST_LABEL;
const readyPath = process.env.AIFIOS_LOCK_TEST_READY_PATH;
const barrierPath = process.env.AIFIOS_LOCK_TEST_BARRIER_PATH;
const activePath = process.env.AIFIOS_LOCK_TEST_ACTIVE_PATH;
const eventPath = process.env.AIFIOS_LOCK_TEST_EVENT_PATH;

if (!label || !readyPath || !barrierPath || !activePath || !eventPath) {
  throw new Error('write-guard child test environment is incomplete');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

await appendFile(readyPath, `${label}\n`);
while (true) {
  try {
    await access(barrierPath);
    break;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await sleep(10);
  }
}

await withProjectWriteLock('cross-process-stale-reclaim', async () => {
  try {
    await mkdir(activePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      await appendFile(eventPath, `OVERLAP ${label}\n`);
    }
    throw error;
  }

  try {
    await appendFile(eventPath, `start ${label}\n`);
    await sleep(80);
    await appendFile(eventPath, `end ${label}\n`);
  } finally {
    await rm(activePath, { recursive: true, force: true });
  }
}, { timeoutMs: 3_000, staleMs: 0 });
