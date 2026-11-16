import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const BASE_URL = process.env.AIFIOS_BASE_URL || process.argv[2] || 'http://127.0.0.1:3004';
const PROJECT_DIR = process.env.AIFIOS_PROJECT || join(homedir(), 'ai-content-system');
const stamp = `publish-smoke-${Date.now()}`;

const fixtures = {
  wechat: `# AI 时代，创始人的内容生产不是写作，而是资产沉淀

很多创始人做内容，一开始就错了。他们以为自己缺的是一个标题，其实缺的是一个能接住真实判断的系统。

## 为什么会卡住
真实判断散落在访谈、路演和客户沟通里，如果不结构化，很快就会消失。

## 怎么做
先接住素材，再拆角度、做平台表达和可信审核。`,
  xhsMissingTags: `# 创始人做内容，不是更快写稿

## 封面三行
- 创始人做内容
- 不是更快写稿
- 而是沉淀资产

## 卡片结构
- 第 1 张：创始人做内容，不是更快写稿
- 第 2 张：为什么真实判断会流失
- 第 3 张：一段访谈能拆成三种资产
- 第 4 张：先做素材理解，再做平台表达
- 第 5 张：不要把经验包装成行业定论
- 第 6 张：评论区留下你的素材场景`,
};

async function writeProjectFile(relativePath, content) {
  const absolutePath = join(PROJECT_DIR, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
  return relativePath;
}

async function postPublishAssets(body) {
  const response = await fetch(`${BASE_URL}/api/publish-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoReadyVisualAssets(deliverable, label) {
  for (const asset of deliverable.visualAssets || []) {
    assert(asset.status !== 'ready', `${label} planned visual asset was incorrectly marked ready: ${asset.label}`);
  }
}

async function cleanup(paths) {
  await Promise.all(paths.map(async (relativePath) => {
    if (!relativePath) return;
    await rm(join(PROJECT_DIR, relativePath), { recursive: true, force: true });
  }));
}

const written = [];
const cleanupDirs = [];

try {
  const wechatPath = await writeProjectFile(`pipeline/final/${stamp}-wechat.md`, fixtures.wechat);
  const xhsPath = await writeProjectFile(`pipeline/xhs/${stamp}-xhs.md`, fixtures.xhsMissingTags);
  written.push(wechatPath, xhsPath);

  const wechatOnly = await postPublishAssets({
    slug: `${stamp}-wechat-only`,
    topic: '公众号 only 对抗测试',
    writePath: wechatPath,
  });
  assert(wechatOnly.platformDeliverables?.wechat, 'wechat only should include wechat deliverable');
  assert(!wechatOnly.platformDeliverables?.xiaohongshu, 'wechat only should not include xiaohongshu deliverable');
  assert(wechatOnly.platformDeliverables.wechat.htmlCandidates.length >= 2, 'wechat should include parallel html candidates');
  assertNoReadyVisualAssets(wechatOnly.platformDeliverables.wechat, 'wechat');
  cleanupDirs.push(`pipeline/publish-assets/${stamp}-wechat-only`, `pipeline/visual/${stamp}-wechat-only`);
  written.push(wechatOnly.reportPath, ...(wechatOnly.generatedPaths || []));

  const allPlatforms = await postPublishAssets({
    slug: `${stamp}-all`,
    topic: '双平台对抗测试',
    writePath: wechatPath,
    xhsPath,
  });
  assert(allPlatforms.platformDeliverables?.wechat, 'all platforms should include wechat');
  assert(allPlatforms.platformDeliverables?.xiaohongshu, 'all platforms should include xiaohongshu');
  assert(allPlatforms.platformDeliverables.xiaohongshu.tags.length > 0, 'xhs missing tags should be repaired');
  assertNoReadyVisualAssets(allPlatforms.platformDeliverables.xiaohongshu, 'xhs');
  cleanupDirs.push(`pipeline/publish-assets/${stamp}-all`, `pipeline/visual/${stamp}-all`);
  written.push(allPlatforms.reportPath, ...(allPlatforms.generatedPaths || []));

  console.log(JSON.stringify({
    ok: true,
    baseUrl: BASE_URL,
    cases: ['wechat-only', 'all-platforms', 'xhs-missing-tags', 'planned-assets-not-ready'],
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error(`Ensure the UI server is running, then retry: AIFIOS_BASE_URL=${BASE_URL} node scripts/publish-assets-adversarial-smoke.mjs`);
  process.exitCode = 1;
} finally {
  await cleanup([...new Set([...written, ...cleanupDirs])]);
}
