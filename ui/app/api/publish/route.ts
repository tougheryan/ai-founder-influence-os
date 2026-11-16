import { expectedUserFacingErrorResponse } from '@/lib/user-facing-error';

/**
 * Retired direct-publish endpoint.
 *
 * Publication evidence now has to be attached to one approved local draft job
 * through /api/publish/results. Keeping this route writable would let callers
 * skip the content, visual, and draft-information approval chain.
 */
export async function POST() {
  return expectedUserFacingErrorResponse({
    error: '请从发布工作台保存实际发布结果。',
    code: 'direct_publish_record_retired',
    status: 410,
    action: { label: '打开发布工作台', href: '/publication-desk' },
    extra: { migration: '/api/publish/results' },
  });
}
