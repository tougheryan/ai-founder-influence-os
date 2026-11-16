import type { SkillDefinition } from './types';

export async function fetchSkillDefinition(skillName: string): Promise<SkillDefinition | null> {
  try {
    const res = await fetch(`/api/skills?skill=${encodeURIComponent(skillName)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      name: data.name,
      description: data.description,
      triggerWords: data.triggerWords || [],
      systemPrompt: '',
      parameters: data.parameters || [],
    };
  } catch {
    return null;
  }
}
