import { describe, expect, it } from 'vitest';
import { CURATED_SKILLS, CURATED_SKILL_IDS, CuratedSkillSelectionSchema, GOG_SKILL_MD, selectedCuratedSkills } from '../src/openclaw/skills.js';

describe('the curated skill selection boundary', () => {
  it('preserves the legacy Google default without treating an explicit empty list as missing', () => {
    expect(selectedCuratedSkills()).toEqual(['gog']);
    expect(selectedCuratedSkills([])).toEqual([]);
    expect(CuratedSkillSelectionSchema.parse([])).toEqual([]);
    expect(CuratedSkillSelectionSchema.safeParse(undefined).success).toBe(false);
    expect(CuratedSkillSelectionSchema.optional().parse(undefined)).toBeUndefined();
  });

  it('canonicalizes a valid selection without modifying the caller or sharing its result', () => {
    const input = ['hatchabot-planning', 'gog', 'hatchabot-research'];
    const expected = ['gog', 'hatchabot-research', 'hatchabot-planning'];
    expect(CuratedSkillSelectionSchema.parse(input)).toEqual(expected);
    expect(input).toEqual(['hatchabot-planning', 'gog', 'hatchabot-research']);
    const result = selectedCuratedSkills(input);
    expect(result).toEqual(expected);
    result.length = 0;
    expect(selectedCuratedSkills(input)).toEqual(expected);
  });

  it('filters obsolete or untrusted internal IDs while retaining canonical known IDs once', () => {
    expect(selectedCuratedSkills(['gone', '../gog', '__proto__', 'constructor', 'gog', 'gog', 'hatchabot-writing']))
      .toEqual(['gog', 'hatchabot-writing']);
  });

  it.each([
    null, 'gog', { gog: true }, [1], [null], ['unknown'], ['GOG'], [' gog '],
    ['../gog'], ['/tmp/gog'], ['gog/SKILL.md'], ['gog\u0000'], ['__proto__'],
    ['gog', 'gog'], [...CURATED_SKILL_IDS, 'gog'],
  ])('rejects invalid public selection %#', (input) => {
    expect(CuratedSkillSelectionSchema.safeParse(input).success).toBe(false);
  });

  it('accepts every catalog item together and returns catalog order', () => {
    expect(CuratedSkillSelectionSchema.parse([...CURATED_SKILL_IDS].reverse())).toEqual(CURATED_SKILL_IDS);
  });
});

describe('the bundled curated catalog', () => {
  it('uses unique path-safe IDs matching the skill frontmatter, with no installation or tool-grant metadata', () => {
    expect(new Set(CURATED_SKILL_IDS).size).toBe(CURATED_SKILLS.length);
    for (const skill of CURATED_SKILLS) {
      expect(skill.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(skill.content).toMatch(new RegExp(`^---\\nname: ${skill.id}\\ndescription: [^\\n]+\\n`));
      expect(skill.name.trim()).not.toBe('');
      expect(skill.description.trim()).not.toBe('');
      expect(skill.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(skill.requirements.every((value) => typeof value === 'string' && value.trim().length > 0)).toBe(true);
      expect((skill.setup ?? []).every((value) => typeof value === 'string' && value.trim().length > 0)).toBe(true);
      expect((skill.examples ?? []).every((value) => typeof value === 'string' && value.trim().length > 0)).toBe(true);
      const frontmatter = skill.content.split('\n---\n')[0]!;
      expect(frontmatter).not.toMatch(/(?:^|["\s])(?:install|allowed-tools|apiKey|primaryEnv)["\s:]/);
    }
  });

  it('keeps the existing Google pack and names prerequisite accounts and browser settings honestly', () => {
    expect(CURATED_SKILLS.find((skill) => skill.id === 'gog')?.content).toBe(GOG_SKILL_MD);
    expect(CURATED_SKILLS.find((skill) => skill.id === 'gog')?.requirements.join(' ')).toMatch(/Google account connected to this agent/);
    expect(CURATED_SKILLS.find((skill) => skill.id === 'hatchabot-browser')?.requirements.join(' ')).toMatch(/Browser must be enabled/);
  });

  it('adds Jira and images as explicit choices without changing the legacy default', () => {
    expect(CuratedSkillSelectionSchema.parse(['hatchabot-images', 'hatchabot-jira']))
      .toEqual(['hatchabot-jira', 'hatchabot-images']);
    expect(selectedCuratedSkills()).toEqual(['gog']);
    expect(selectedCuratedSkills([])).toEqual([]);
    for (const id of ['hatchabot-jira', 'hatchabot-images']) {
      const skill = CURATED_SKILLS.find((item) => item.id === id)!;
      expect(skill.setup!.length).toBeGreaterThan(0);
      expect(skill.examples!.some((prompt) => /do not (create|generate)/i.test(prompt))).toBe(true);
    }
  });

  it('Jira offers drafts and an existing browser or connector without inventing access or commands', () => {
    const skill = CURATED_SKILLS.find((item) => item.id === 'hatchabot-jira')!;
    expect(skill.requirements.join(' ')).toMatch(/Drafting from supplied text needs no Jira connection/);
    expect(skill.content).toContain('does not claim that Hatchabot bundles an Atlassian connector');
    expect(skill.content).toContain('do not create duplicate issues or comments');
    expect(skill.content).toContain('fresh `snapshot` before `act`');
    expect(skill.content).not.toMatch(/jira_search|jira_create|curl |Authorization:|api[_-]?key\s*=/i);
  });

  it('image instructions distinguish analysis, readiness and generation, with a single explicit request', () => {
    const skill = CURATED_SKILLS.find((item) => item.id === 'hatchabot-images')!;
    expect(skill.requirements.join(' ')).toContain('supported provider');
    expect(skill.content).toContain('The `image` tool analyzes existing images');
    expect(skill.content).toContain('action `list`');
    expect(skill.content).toContain('Invoke generation once');
    expect(skill.content).toContain('use action `status`');
    expect(skill.content).toContain('does not authorize repeated batches');
    expect(skill.content).toContain('do not claim an image\n   exists');
    expect(skill.content).toContain('Do not use JPEG for a transparent background');
    expect(skill.content).toContain('agents.defaults.imageGenerationModel.primary');
  });
});
