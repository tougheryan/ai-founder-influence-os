import { readFile } from 'fs/promises';
import { isAbsolute, relative } from 'path';
import { runtimeJoin, safeResolve, SKILLS_DIR } from './project-root';

export { SKILLS_DIR };

type ManifestSkill = {
  name: string;
  path: string;
};

export type ActiveSkill = {
  name: string;
  filePath: string;
};

export class SkillNotActiveError extends Error {
  constructor(skill: string) {
    super(`Skill 未在当前安装清单中启用：${skill}`);
    this.name = 'SkillNotActiveError';
  }
}

export class SkillManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillManifestError';
  }
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function safeSkillPath(relativeSkillFile: string): string {
  const resolved = safeResolve(SKILLS_DIR, relativeSkillFile);
  if (!resolved) throw new SkillManifestError('技能清单中的 Skill 路径不安全');
  const relation = relative(SKILLS_DIR, resolved);
  if (relation === '..' || relation.startsWith('../') || isAbsolute(relation)) {
    throw new SkillManifestError('技能清单中的 Skill 路径不安全');
  }
  return resolved;
}

async function manifestSkills(): Promise<ManifestSkill[]> {
  let raw: string;
  try {
    raw = await readFile(runtimeJoin(SKILLS_DIR, 'manifest.json'), 'utf-8');
  } catch {
    throw new SkillManifestError('无法读取当前安装的 Skill 清单');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SkillManifestError('当前安装的 Skill 清单不是有效 JSON');
  }

  const included = parsed && typeof parsed === 'object'
    ? (parsed as { included_skills?: unknown }).included_skills
    : undefined;
  if (!Array.isArray(included)) {
    throw new SkillManifestError('当前安装的 Skill 清单缺少 included_skills');
  }

  const seen = new Set<string>();
  return included.map((entry): ManifestSkill => {
    if (!entry || typeof entry !== 'object') {
      throw new SkillManifestError('当前安装的 Skill 清单包含无效条目');
    }
    const { name, path } = entry as { name?: unknown; path?: unknown };
    if (typeof name !== 'string' || !SKILL_NAME_RE.test(name) || typeof path !== 'string') {
      throw new SkillManifestError('当前安装的 Skill 清单包含无效名称或路径');
    }
    if (seen.has(name)) {
      throw new SkillManifestError(`当前安装的 Skill 清单包含重复项：${name}`);
    }
    seen.add(name);

    // The manifest lives in skills/, while its install paths are rooted at the
    // app root. Keeping this exact mapping prevents it from becoming an
    // arbitrary local-file allowlist.
    if (path !== `skills/${name}/SKILL.md`) {
      throw new SkillManifestError(`当前安装的 Skill 清单路径无效：${name}`);
    }
    return { name, path };
  });
}

export async function listSkills(): Promise<string[]> {
  return (await manifestSkills()).map((skill) => skill.name);
}

export async function assertActiveSkill(skill: string): Promise<ActiveSkill> {
  const manifestSkill = (await manifestSkills()).find((entry) => entry.name === skill);
  if (!manifestSkill) throw new SkillNotActiveError(skill);

  return {
    name: manifestSkill.name,
    filePath: safeSkillPath(manifestSkill.path.slice('skills/'.length)),
  };
}

export async function readSkillMd(skill: string): Promise<string> {
  const activeSkill = await assertActiveSkill(skill);
  return readFile(activeSkill.filePath, 'utf-8');
}
