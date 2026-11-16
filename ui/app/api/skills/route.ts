import { NextRequest, NextResponse } from 'next/server';
import { assertActiveSkill, listSkills, SkillNotActiveError } from '@/lib/skill-files';
import { loadSkill } from '@/lib/skill-loader';
import { KnownUserFacingError, userFacingErrorResponse } from '@/lib/user-facing-error';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const skillName = searchParams.get('skill');

    if (skillName) {
      await assertActiveSkill(skillName);
      const skill = await loadSkill(skillName);
      return NextResponse.json({
        name: skillName,
        description: skill.description,
        triggerWords: skill.triggerWords,
        parameters: skill.parameters,
      });
    }

    const names = await listSkills();
    const skills = await Promise.all(names.map(async (name) => {
      const skill = await loadSkill(name);
      return {
        name,
        description: skill.description,
        triggerWords: skill.triggerWords,
        parameters: skill.parameters,
      };
    }));

    return NextResponse.json({ skills });
  } catch (error) {
    const status = error instanceof SkillNotActiveError ? 404 : 500;
    const cause = error instanceof SkillNotActiveError
      ? new KnownUserFacingError({
        error: '这个功能当前不可用。',
        code: 'feature_not_available',
      }, { status: 404, detail: error })
      : error;
    return userFacingErrorResponse(cause, {
      error: status === 404 ? '这个功能当前不可用。' : '暂时无法读取功能列表，请重试。',
      code: status === 404 ? 'feature_not_available' : 'features_read_failed',
      status,
    });
  }
}
