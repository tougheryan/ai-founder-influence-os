import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TechnicalDetailList, TechnicalDetails } from './TechnicalDetails';

describe('TechnicalDetails', () => {
  it('keeps technical identifiers inside a closed disclosure by default', () => {
    const html = renderToStaticMarkup(
      <TechnicalDetails>
        <TechnicalDetailList items={[{ label: '任务编号', value: 'run-secret-123' }]} />
      </TechnicalDetails>,
    );

    expect(html).toContain('<details');
    expect(html).not.toContain('<details open=""');
    expect(html).toContain('技术详情');
    expect(html).toContain('run-secret-123');
  });
});
