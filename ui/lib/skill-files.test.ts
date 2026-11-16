import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertActiveSkill,
  listSkills,
  readSkillMd,
  SKILLS_DIR,
  SkillNotActiveError,
} from './skill-files';

let activeNames: string[] = [];

beforeAll(async () => {
  const manifest = JSON.parse(await readFile(join(SKILLS_DIR, 'manifest.json'), 'utf-8')) as {
    included_skills: Array<{ name: string }>;
  };
  activeNames = manifest.included_skills.map((skill) => skill.name);
});

describe('manifest-bound skill files', () => {
  it('enumerates exactly the install manifest surface', async () => {
    expect(await listSkills()).toEqual(activeNames);
    expect(activeNames).not.toContain('content-angle');
  });

  it('reads an active skill only through its manifest entry', async () => {
    const skill = await assertActiveSkill('content-intake');

    expect(skill.filePath).toBe(join(SKILLS_DIR, 'content-intake', 'SKILL.md'));
    await expect(readSkillMd('content-intake')).resolves.toContain('name: content-intake');
  });

  it('rejects historical and unknown skills instead of resolving local folders', async () => {
    await expect(readSkillMd('content-angle')).rejects.toBeInstanceOf(SkillNotActiveError);
    await expect(readSkillMd('not-a-real-skill')).rejects.toBeInstanceOf(SkillNotActiveError);
  });
});
