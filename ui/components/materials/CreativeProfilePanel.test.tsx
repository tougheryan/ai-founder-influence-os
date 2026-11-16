import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CreativeProfilePanel } from './CreativeProfilePanel';
import { DraftPreferenceReuse } from './DraftPreferenceReuse';

describe('writing settings entry', () => {
  it('starts with three practical preferences and leaves other account details collapsed', () => {
    const html = renderToStaticMarkup(<CreativeProfilePanel profile={null} rules={null} pendingProfileCount={0} pendingRulesCount={0} onSaveProfile={async () => {}} onSaveRules={async () => {}} onOpenProposals={() => {}} />);
    const beforeDetails = html.split('<details')[0];
    expect(beforeDetails).toContain('写给谁'); expect(beforeDetails).toContain('怎样表达'); expect(beforeDetails).toContain('不要写什么');
    expect(beforeDetails).not.toContain('账号类型'); expect(html).not.toContain('<details open'); expect(html).not.toContain('/14');
    expect(html).toContain('填一项也可以'); expect(html).toContain('本篇明确提出的要求优先');
  });
  it('does not fetch, preselect, or save anything merely by rendering the optional entry', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    try {
      const html = renderToStaticMarkup(<DraftPreferenceReuse runId="run-a" inputFingerprint={'a'.repeat(64)} />);
      expect(html).toContain('挑选长期偏好'); expect(html).not.toContain('checkbox'); expect(fetch).not.toHaveBeenCalled();
      expect(renderToStaticMarkup(<DraftPreferenceReuse runId="run-a" inputFingerprint={'a'.repeat(64)} disabled />)).toBe('');
      expect(renderToStaticMarkup(<DraftPreferenceReuse runId="" inputFingerprint={'a'.repeat(64)} />)).toBe('');
    } finally { vi.unstubAllGlobals(); }
  });
});
