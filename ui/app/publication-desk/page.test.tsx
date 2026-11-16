import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  publicationJobDisplayLabel,
  publicationJobErrorCopy,
  publicationPrimaryAction,
  safePublicationJobErrorCode,
} from '@/lib/publication-display-copy';
import {
  canExplicitlyRetryLocalDraft,
  canRecordPublicationEvidence,
  MANUAL_DRAFT_RETRY_CONFIRMATION,
  publicationQueueMatchesIntegrity,
} from '@/lib/production-flow';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import PublicationDeskPage from './page';

const pageSource = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');

describe('PublicationDeskPage', () => {
  it('uses the current content as the primary path and keeps file paths in technical details', () => {
    const html = renderToStaticMarkup(<PublicationDeskPage />);

    expect(html).toContain('data-testid="publication-current-run"');
    expect(html).toContain('生成所选平台发布内容');
    expect(html).toContain('分别准备原生发布内容');
    expect(html).toContain('不会生成未选平台');
    expect(html).toContain('文件可下载');
    expect(html).not.toContain('填入草稿并生成文件');
    expect(html).toContain('data-testid="publication-advanced-diagnostics"');
    expect(html).toContain('手动选择文件（高级）');
    expect(html).toContain('任务编号（可选）');
  });

  it('shows exactly one next primary action for the current queue state', () => {
    const html = renderToStaticMarkup(<PublicationDeskPage />);

    expect(html).toContain('生成所选平台发布内容');
    expect(html).not.toContain('填入草稿并生成文件');
    expect(publicationPrimaryAction(false, false)).toBe('prepare');
    expect(publicationPrimaryAction(true, false)).toBe('prepare');
    expect(publicationPrimaryAction(false, true)).toBe('prepare');
    expect(publicationPrimaryAction(true, true)).toBe('execute');
    expect(pageSource).toContain("primaryAction === 'prepare' ?");
  });

  it('maps job errors from safe codes without exposing legacy raw messages', () => {
    const rawMessage = 'ENOENT /Users/customer/private/project.json token=secret';
    const xiaohongshu = publicationJobErrorCopy({
      platform: 'xiaohongshu',
      status: 'manual_intervention_required',
      last_error: { code: 'browser_session_required', message: rawMessage },
    });
    const unknown = publicationJobErrorCopy({
      platform: 'wechat',
      status: 'retryable_failure',
      last_error: { code: '/Users/customer/private/project.json', message: rawMessage },
    });

    expect(xiaohongshu).toBe('还没有登录小红书。打开编辑器完成登录后再试。');
    expect(unknown).toContain('请重试');
    expect(`${xiaohongshu}${unknown}`).not.toContain(rawMessage);
    expect(safePublicationJobErrorCode('/Users/customer/private/project.json')).toBe('unknown_error');
    expect(pageSource).not.toMatch(/\{job\.last_error(?:\?\.)?message\}/);
    expect(pageSource).not.toContain('>{job.last_error.message}<');
  });

  it('keeps legacy queue labels readable without showing the old execution-package term', () => {
    expect(publicationJobDisplayLabel({
      platform: 'shipinhao',
      item_id: 'shipinhao-video-execution-1',
      delivery_kind: 'execution_package',
    })).toBe('视频号口播稿与拍摄说明 1');
    expect(publicationJobDisplayLabel({
      platform: 'douyin',
      item_id: 'douyin-video-execution-2',
      delivery_kind: 'execution_package',
    })).toBe('抖音口播稿与拍摄说明 2');
    expect(pageSource).toContain('publicationJobDisplayLabel(job)');
    expect(pageSource).not.toContain('{job.item_label}');
  });

  it('keeps the optional local proof path inside collapsed technical details', () => {
    const technicalDetails = pageSource.indexOf('summary="添加本地凭证（高级）"');
    const proofPath = pageSource.indexOf('本地凭证文件路径（可选）');

    expect(technicalDetails).toBeGreaterThan(-1);
    expect(proofPath).toBeGreaterThan(technicalDetails);
    expect(pageSource).not.toContain('发布截图或凭证文件（可选）');
  });

  it('allows actions only for the queue whose live lineage matches the current run', () => {
    const queue = {
      run_id: 'run-a',
      run_slug: 'run-a',
      package_path: 'pipeline/package/run-a.md',
      jobs: [],
    } as Parameters<typeof publicationQueueMatchesIntegrity>[0];
    const integrity = {
      run_id: 'run-a',
      slug: 'run-a',
      draft_queue: {
        path: 'materials/publication/drafts/run-a/draft-queue.json',
        total: 11,
        complete: true,
        lineage_current: true,
        status_counts: { pending: 11 },
      },
      resolved_paths: {
        package_path: 'pipeline/package/run-a.md',
        deliverables_path: 'pipeline/publish-assets/run-a-platform-deliverables.json',
        visual_manifest_path: 'pipeline/visual/run-a/selected-assets.json',
        draft_queue_path: 'materials/publication/drafts/run-a/draft-queue.json',
        publication_ledger_path: 'materials/publication/ledger/run-a/publication-ledger.json',
      },
    } as Parameters<typeof publicationQueueMatchesIntegrity>[1];

    expect(publicationQueueMatchesIntegrity(queue, integrity, integrity?.resolved_paths.draft_queue_path || '')).toBe(true);
    expect(publicationQueueMatchesIntegrity(queue, {
      ...integrity,
      draft_queue: { ...integrity?.draft_queue, lineage_current: false },
    } as Parameters<typeof publicationQueueMatchesIntegrity>[1], integrity?.resolved_paths.draft_queue_path || '')).toBe(false);
    expect(publicationQueueMatchesIntegrity(queue, integrity, 'materials/publication/drafts/other/draft-queue.json')).toBe(false);
  });

  it('never opens publication-result capture for a downloadable execution package', () => {
    expect(canRecordPublicationEvidence({ delivery_kind: 'execution_package', status: 'draft_filled' }, true)).toBe(false);
    expect(canRecordPublicationEvidence({ delivery_kind: 'draft_fill', status: 'draft_filled' })).toBe(true);
  });

  it('offers an explicit confirmed retry for resolved manual prerequisites but never for unknown completion', () => {
    expect(canExplicitlyRetryLocalDraft({ status: 'manual_intervention_required' })).toBe(true);
    expect(canExplicitlyRetryLocalDraft({ status: 'unknown_completion' })).toBe(false);
    expect(MANUAL_DRAFT_RETRY_CONFIRMATION).toContain('我已完成登录、验证码、设备确认或本机桥配对');
    expect(MANUAL_DRAFT_RETRY_CONFIRMATION).toContain('不会点击公开发送');
  });
});
