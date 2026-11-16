import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(process.cwd(), 'app');

function pageSource(route: string): string {
  return readFileSync(resolve(APP_ROOT, route, 'page.tsx'), 'utf8');
}

describe('commercial page boundaries', () => {
  it.each([
    ['pipeline', '/production?stage=1'],
    ['delivery', '/production?stage=4'],
    ['brain', '/materials'],
    ['twin', '/weekly-review'],
  ])('retires /%s into %s without a second state surface', (route, target) => {
    const source = pageSource(route);
    expect(source).toContain(`redirect('${target}')`);
    expect(source).not.toContain("'use client'");
  });

  it.each([
    ['case', '/production?stage=1'],
    ['closing', '/'],
  ])('keeps /%s behind the explicit demo-only environment gate', (route, target) => {
    const source = pageSource(route);
    expect(source).toContain("process.env.AIFIOS_ENABLE_DEMO_SURFACES !== '1'");
    expect(source).toContain(`redirect('${target}')`);
    expect(source).toContain('await connection()');
  });
});
