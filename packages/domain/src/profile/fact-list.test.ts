import { describe, it, expect } from 'vitest';
import { CareerProfile } from './career-profile.js';
import { compileFactList } from './fact-list.js';
import { asUserId } from '../shared/ids.js';
import { isOk } from '../shared/result.js';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');

/** One fixture profile covering every ProfileSection kind (task 037 test plan). */
function buildFixtureProfile() {
  const created = CareerProfile.create({ userId: USER, title: 'Full Profile' });
  if (!isOk(created)) throw new Error('fixture setup failed');
  const profile = created.value;

  const add = (args: Parameters<typeof profile.addSection>[0]) => {
    const r = profile.addSection(args);
    if (!isOk(r)) throw new Error(`fixture setup failed: ${JSON.stringify(r.error)}`);
    return r.value;
  };

  const experience = add({
    kind: 'experience',
    content: {
      schemaVersion: 1,
      title: 'Senior Engineer',
      organization: 'Acme Corp',
      startDate: '2021-01',
      endDate: '2023-06',
      bullets: ['Led migration of X', 'Reduced latency by 40%'],
    },
  });
  const experienceNoBullets = add({
    kind: 'experience',
    content: {
      schemaVersion: 1,
      title: 'Intern',
      organization: 'Startup Inc',
      startDate: '2019-06',
      endDate: '2019-08',
      bullets: [],
    },
  });
  const education = add({
    kind: 'education',
    content: {
      schemaVersion: 1,
      institution: 'State University',
      credential: 'B.S. Computer Science',
      startDate: '2015-09',
      endDate: '2019-05',
      details: ['Graduated with honors'],
    },
  });
  const educationNoDetails = add({
    kind: 'education',
    content: {
      schemaVersion: 1,
      institution: 'Community College',
      credential: 'A.A. General Studies',
      startDate: '2013-09',
      endDate: '2015-05',
    },
  });
  const project = add({
    kind: 'project',
    content: {
      schemaVersion: 1,
      name: 'CareerPilot',
      description: 'AI job-search assistant',
      bullets: ['Built the matching pipeline'],
    },
  });
  const skillGroup = add({
    kind: 'skill_group',
    content: { schemaVersion: 1, groupName: 'Languages', skills: ['TypeScript', 'Python'] },
  });
  const certification = add({
    kind: 'certification',
    content: { schemaVersion: 1, name: 'AWS Certified Developer', issuer: 'Amazon', issuedDate: '2022-03' },
  });
  const summary = add({
    kind: 'summary',
    content: { schemaVersion: 1, text: 'Experienced backend engineer.' },
  });

  return {
    profile,
    sectionIds: {
      experience: experience.id,
      experienceNoBullets: experienceNoBullets.id,
      education: education.id,
      educationNoDetails: educationNoDetails.id,
      project: project.id,
      skillGroup: skillGroup.id,
      certification: certification.id,
      summary: summary.id,
    },
  };
}

describe('compileFactList', () => {
  it('is pure and deterministic: identical calls on an unchanged profile produce byte-identical output', () => {
    const { profile } = buildFixtureProfile();
    const first = compileFactList(profile);
    const second = compileFactList(profile);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('every ProfileSection kind produces at least one fact', () => {
    const { profile, sectionIds } = buildFixtureProfile();
    const facts = compileFactList(profile);
    for (const sectionId of Object.values(sectionIds)) {
      expect(facts.some((f) => f.sectionId === sectionId)).toBe(true);
    }
  });

  it('bullet/skill/detail-array kinds produce one fact PER entry, not one blob per section', () => {
    const { profile, sectionIds } = buildFixtureProfile();
    const facts = compileFactList(profile);

    const experienceFacts = facts.filter((f) => f.sectionId === sectionIds.experience);
    expect(experienceFacts).toHaveLength(2); // 2 bullets -> 2 facts

    const skillFacts = facts.filter((f) => f.sectionId === sectionIds.skillGroup);
    expect(skillFacts).toHaveLength(2); // 2 skills -> 2 facts
    expect(skillFacts.map((f) => f.text)).toEqual(['TypeScript (Languages)', 'Python (Languages)']);

    // No-bullets / no-details fall back to exactly ONE synthesized fact, not zero.
    expect(facts.filter((f) => f.sectionId === sectionIds.experienceNoBullets)).toHaveLength(1);
    expect(facts.filter((f) => f.sectionId === sectionIds.educationNoDetails)).toHaveLength(1);

    // certification/summary (no array field at all) also produce exactly one fact.
    expect(facts.filter((f) => f.sectionId === sectionIds.certification)).toHaveLength(1);
    expect(facts.filter((f) => f.sectionId === sectionIds.summary)).toHaveLength(1);
  });

  it('golden fixture: exact fact list content for every kind (plain data equality, task 024-style but not byte-file)', () => {
    const { profile, sectionIds } = buildFixtureProfile();
    const facts = compileFactList(profile);

    const bySection = (id: string) => facts.filter((f) => f.sectionId === id).map((f) => f.text);

    expect(bySection(sectionIds.experience)).toEqual([
      'Led migration of X — Senior Engineer at Acme Corp, 2021-01–2023-06',
      'Reduced latency by 40% — Senior Engineer at Acme Corp, 2021-01–2023-06',
    ]);
    expect(bySection(sectionIds.experienceNoBullets)).toEqual([
      'Intern at Startup Inc, 2019-06–2019-08',
    ]);
    expect(bySection(sectionIds.education)).toEqual([
      'Graduated with honors — B.S. Computer Science, State University, 2015-09–2019-05',
    ]);
    expect(bySection(sectionIds.educationNoDetails)).toEqual([
      'A.A. General Studies, Community College, 2013-09–2015-05',
    ]);
    expect(bySection(sectionIds.project)).toEqual([
      'Built the matching pipeline — Project: CareerPilot — AI job-search assistant',
    ]);
    expect(bySection(sectionIds.skillGroup)).toEqual(['TypeScript (Languages)', 'Python (Languages)']);
    expect(bySection(sectionIds.certification)).toEqual([
      'AWS Certified Developer, issued by Amazon, issued 2022-03',
    ]);
    expect(bySection(sectionIds.summary)).toEqual(['Experienced backend engineer.']);

    // Ids are "F{n}" and globally sequential across the whole (id-sorted) fact list.
    expect(facts.map((f) => f.id)).toEqual(facts.map((_, i) => `F${i + 1}`));
  });

  it('a fact-less-content edit changes only the affected facts\' text, not their ids, when no section is added/removed/reordered by id', () => {
    const { profile, sectionIds } = buildFixtureProfile();
    const before = compileFactList(profile);
    const beforeIds = before.map((f) => f.id);

    // Edit an EXISTING section's content in place (same section id, same
    // position in the id-sorted walk) — bullet COUNT unchanged.
    const updated = profile.updateSection(sectionIds.summary, {
      schemaVersion: 1,
      text: 'Experienced backend engineer, now tailored.',
    });
    expect(isOk(updated)).toBe(true);

    const after = compileFactList(profile);
    expect(after.map((f) => f.id)).toEqual(beforeIds); // ids unchanged in this case
    const summaryFact = after.find((f) => f.sectionId === sectionIds.summary)!;
    expect(summaryFact.text).toBe('Experienced backend engineer, now tailored.');
  });

  it('KNOWN LIMITATION (documented, not silently shipped): removing a section shifts every subsequent fact id — ids are position-derived, not content-stable', () => {
    const { profile, sectionIds } = buildFixtureProfile();
    const before = compileFactList(profile);
    const lastFactBefore = before[before.length - 1]!;

    const removed = profile.removeSection(sectionIds.certification);
    expect(isOk(removed)).toBe(true);

    const after = compileFactList(profile);
    // The fact list is shorter, and everything from the removal point on has
    // been renumbered — the last fact's id is NOT preserved, even though its
    // TEXT (if it belongs to an unrelated, later-sorted section) may be.
    expect(after.length).toBeLessThan(before.length);
    expect(after.some((f) => f.id === lastFactBefore.id && f.text === lastFactBefore.text)).toBe(false);
  });

  it('an empty profile (no sections) compiles to an empty fact list, not an error', () => {
    const created = CareerProfile.create({ userId: USER, title: 'Empty' });
    if (!isOk(created)) throw new Error('setup failed');
    expect(compileFactList(created.value)).toEqual([]);
  });
});
