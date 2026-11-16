import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/research-status', () => ({ readCurrentResearchStatus: fixture.read, ResearchStatusInputError: class extends Error {} }));
import { ResearchStatusInputError } from '@/lib/research-status';
import { GET } from './route';
beforeEach(() => { fixture.read.mockReset(); });
describe('read-only current-draft research status', () => {
  it('uses the explicit task and prevents a cached previous-task result', async () => {
    fixture.read.mockResolvedValue({ runId: 'run-a', state: 'current', platforms: [] });
    const response = await GET(new NextRequest('http://localhost/api/research/status?runId=run-a'));
    expect(fixture.read).toHaveBeenCalledWith('run-a');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).runId).toBe('run-a');
  });
  it('returns a recoverable input error without selecting another active task', async () => {
    fixture.read.mockRejectedValue(new ResearchStatusInputError('请先打开一份草稿。'));
    const response = await GET(new NextRequest('http://localhost/api/research/status'));
    expect(response.status).toBe(400);
    expect(fixture.read).toHaveBeenCalledWith('');
  });
});
