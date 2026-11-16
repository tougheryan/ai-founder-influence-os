import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activeSkills: ['content-intake', 'content-package'],
  loadedSkills: [] as string[],
}));

vi.mock('@/lib/skill-files', () => {
  class SkillNotActiveError extends Error {}
  return {
    SkillNotActiveError,
    listSkills: async () => mocks.activeSkills,
    assertActiveSkill: async (skill: string) => {
      if (!mocks.activeSkills.includes(skill)) {
        throw new SkillNotActiveError(`Skill 未在当前安装清单中启用：${skill}`);
      }
    },
  };
});

vi.mock('@/lib/skill-loader', () => ({
  loadSkill: async (name: string) => {
    mocks.loadedSkills.push(name);
    return {
      description: `${name} description`,
      triggerWords: [`/${name}`],
      parameters: [],
    };
  },
}));

import { GET } from './route';

describe('GET /api/skills', () => {
  beforeEach(() => {
    mocks.activeSkills = ['content-intake', 'content-package'];
    mocks.loadedSkills = [];
  });

  it('lists only the skills enabled by the install manifest', async () => {
    const response = await GET(new NextRequest('http://localhost/api/skills'));

    expect(response.status).toBe(200);
    expect((await response.json()).skills.map((skill: { name: string }) => skill.name))
      .toEqual(['content-intake', 'content-package']);
    expect(mocks.loadedSkills).toEqual(['content-intake', 'content-package']);
  });

  it('returns an enabled skill definition', async () => {
    const response = await GET(new NextRequest('http://localhost/api/skills?skill=content-intake'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: 'content-intake' });
  });

  it('rejects historical and unknown skills instead of reading their folders', async () => {
    const response = await GET(new NextRequest('http://localhost/api/skills?skill=content-angle'));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: '这个功能当前不可用。',
      code: 'feature_not_available',
    });
    expect(mocks.loadedSkills).toEqual([]);
  });
});
