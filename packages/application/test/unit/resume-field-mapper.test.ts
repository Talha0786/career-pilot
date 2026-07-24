import { describe, it, expect } from 'vitest';
import { mapResumeTextToDraft } from '../../src/profile/parsing/resume-field-mapper.js';

const SAMPLE = `Jane Smith
jane.smith@example.com
(555) 123-4567

Summary
Backend engineer with 8 years of experience.

Experience
Senior Software Engineer at Acme Corp
Jan 2020 - Present
- Led migration of the payments service
- Reduced p99 latency by 40%

Software Engineer at Initech
Jun 2016 - Dec 2019
- Built the internal reporting dashboard

Education
State University, B.S. Computer Science
Aug 2012 - May 2016

Skills
Go, TypeScript, PostgreSQL, Kubernetes, gRPC
`;

describe('mapResumeTextToDraft — contact extraction', () => {
  it('extracts name, email, and phone from the header block', () => {
    const draft = mapResumeTextToDraft(SAMPLE);
    expect(draft.contact.name.value).toBe('Jane Smith');
    expect(draft.contact.email.value).toBe('jane.smith@example.com');
    expect(draft.contact.phone.value).toContain('555');
    expect(draft.contact.email.confidence).toBeGreaterThan(0.8);
  });

  it('returns null (not a crash) for missing contact fields', () => {
    const draft = mapResumeTextToDraft('No Contact Info Here\n\nExperience\nSomething');
    expect(draft.contact.phone.value).toBeNull();
  });
});

describe('mapResumeTextToDraft — summary', () => {
  it('captures a Summary/Objective/Profile block', () => {
    const draft = mapResumeTextToDraft(SAMPLE);
    expect(draft.summary.value).toContain('Backend engineer');
  });

  it('is null when no summary section exists', () => {
    const draft = mapResumeTextToDraft('Ann Lee\nann@x.com\n\nExperience\nEngineer at X\n2020 - 2021');
    expect(draft.summary.value).toBeNull();
  });
});

describe('mapResumeTextToDraft — experience', () => {
  it('splits multiple experience entries by date anchors and assigns each its own bullets', () => {
    const draft = mapResumeTextToDraft(SAMPLE);
    const experience = draft.sections.filter((s) => s.kind === 'experience');
    expect(experience).toHaveLength(2);

    const first = experience[0]!.content as { title: string; organization: string; bullets: readonly string[] };
    expect(first.title).toBe('Senior Software Engineer');
    expect(first.organization).toBe('Acme Corp');
    expect(first.bullets).toHaveLength(2);

    const second = experience[1]!.content as { title: string; organization: string; bullets: readonly string[] };
    expect(second.title).toBe('Software Engineer');
    expect(second.organization).toBe('Initech');
    expect(second.bullets).toHaveLength(1);
  });

  it('treats "Present" as an open-ended end date (null)', () => {
    const draft = mapResumeTextToDraft(SAMPLE);
    const first = draft.sections.find((s) => s.kind === 'experience')!.content as { endDate: string | null };
    expect(first.endDate).toBeNull();
  });

  it('supports numeric MM/YYYY date ranges, not just "Month YYYY"', () => {
    const text = 'A B\na@b.com\n\nExperience\nEngineer at Foo\n03/2019 - 08/2022\n- did stuff';
    const draft = mapResumeTextToDraft(text);
    const exp = draft.sections.find((s) => s.kind === 'experience')!.content as { startDate: string; endDate: string | null };
    expect(exp.startDate).toBe('03/2019');
    expect(exp.endDate).toBe('08/2022');
  });

  it('assigns higher confidence to entries with organization, dates, AND bullets than a sparse entry', () => {
    const rich = mapResumeTextToDraft(SAMPLE).sections.find((s) => s.kind === 'experience')!;
    const sparse = mapResumeTextToDraft('A B\na@b.com\n\nExperience\nJust a title with no org or dates').sections.find(
      (s) => s.kind === 'experience',
    )!;
    expect(rich.confidence).toBeGreaterThan(sparse.confidence);
  });
});

describe('mapResumeTextToDraft — education', () => {
  it('extracts institution and credential', () => {
    const draft = mapResumeTextToDraft(SAMPLE);
    const edu = draft.sections.find((s) => s.kind === 'education')!.content as { institution: string; credential: string };
    expect(edu.institution).toBe('State University');
    expect(edu.credential).toBe('B.S. Computer Science');
  });
});

describe('mapResumeTextToDraft — skills', () => {
  it('splits a comma-separated skills line into individual skills', () => {
    const draft = mapResumeTextToDraft(SAMPLE);
    const skills = draft.sections.find((s) => s.kind === 'skill_group')!.content as { skills: readonly string[] };
    expect(skills.skills).toEqual(['Go', 'TypeScript', 'PostgreSQL', 'Kubernetes', 'gRPC']);
  });

  it('splits a semicolon-separated skills line too', () => {
    const draft = mapResumeTextToDraft('A B\na@b.com\n\nSkills\nPython; Django; React');
    const skills = draft.sections.find((s) => s.kind === 'skill_group')!.content as { skills: readonly string[] };
    expect(skills.skills).toEqual(['Python', 'Django', 'React']);
  });
});

describe('mapResumeTextToDraft — projects', () => {
  it('groups a title + description line + bullets into ONE project entry, not three', () => {
    const text =
      'A B\na@b.com\n\nProjects\nCampus App\nA ride-share matching app\n- Implemented matching\n- Deployed on Heroku';
    const draft = mapResumeTextToDraft(text);
    const projects = draft.sections.filter((s) => s.kind === 'project');
    expect(projects).toHaveLength(1);
    const content = projects[0]!.content as { name: string; description: string; bullets: readonly string[] };
    expect(content.name).toBe('Campus App');
    expect(content.description).toBe('A ride-share matching app');
    expect(content.bullets).toHaveLength(2);
  });

  it('splits two consecutive project entries correctly', () => {
    const text =
      'A B\na@b.com\n\nProjects\nProject One\nDescription one\n- bullet one\nProject Two\nDescription two\n- bullet two';
    const draft = mapResumeTextToDraft(text);
    const projects = draft.sections.filter((s) => s.kind === 'project');
    expect(projects).toHaveLength(2);
    expect((projects[0]!.content as { name: string }).name).toBe('Project One');
    expect((projects[1]!.content as { name: string }).name).toBe('Project Two');
  });
});

describe('mapResumeTextToDraft — degenerate input', () => {
  it('never throws on empty or garbage text', () => {
    expect(() => mapResumeTextToDraft('')).not.toThrow();
    expect(() => mapResumeTextToDraft('   \n\n   ')).not.toThrow();
    expect(() => mapResumeTextToDraft('!!!@@@###$$$')).not.toThrow();
  });

  it('returns an empty sections list and null contact fields for pure noise', () => {
    const draft = mapResumeTextToDraft('###!!!\n***???');
    expect(draft.sections).toEqual([]);
    expect(draft.contact.email.value).toBeNull();
  });
});
