import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const taskDir = process.argv[2];
if (!taskDir) {
  console.error('usage: node run-screenshot.mjs <task-dir>');
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const htmlPath = 'file://' + join(taskDir, 'index.html');
await page.goto(htmlPath, { waitUntil: 'networkidle' });

const posters = await page.locator('section.poster.xhs').all();
for (let i = 0; i < posters.length; i++) {
  const el = posters[i];
  const id = await el.getAttribute('id');
  const outputName = id ? `${id}.png` : `xhs-${String(i + 1).padStart(2, '0')}.png`;
  const outputPath = join(taskDir, 'output', outputName);
  await el.screenshot({ path: outputPath });
  console.log('saved', outputPath);
}

await browser.close();
