import type { CareerProfile } from './career-profile.js';
import {
  type ProfileSectionKind,
  type ProfileSectionContent,
  type ExperienceContent,
  type EducationContent,
  type ProjectContent,
  type SkillGroupContent,
  type CertificationContent,
  type SummaryContent,
} from './profile-section.js';

/**
 * The fact base at the heart of the anti-hallucination contract
 * (docs/06-agent-design.md §4 point 1): "profile sections are compiled to a
 * numbered fact list (`F1: 'Led migration of X at Company Y, 2021–2023'`)."
 * Every `Fact.text` is self-contained (carries its own context — dates,
 * employer, project name) so it's independently verifiable without having
 * to cross-reference another fact, which is exactly what claim verification
 * (task 040) needs to check a claim against.
 */
export interface Fact {
  readonly id: string; // "F1", "F2", ... — stable ONLY across calls on an unchanged profile, see module doc below
  readonly sectionId: string;
  readonly text: string;
}

/**
 * Pure, deterministic, no I/O (task 037 acceptance criterion). Compiles at
 * BULLET level, not section level — a 4-bullet `ExperienceContent` produces
 * 4 independent facts, not one blob, so claim verification can point at the
 * specific unsupported bullet rather than an entire job's worth of content.
 *
 * DETERMINISM: sections are visited in the SAME canonical order
 * `computeProfileFactsHash` sorts by (`section.id`, lexicographic) — not
 * `section.sort` (display order) — specifically so a profile with an
 * unchanged `factsHash` always compiles to the byte-identical fact list
 * (task 037's core guarantee: `DocumentVersion.profileFactsHash` meaning
 * "these exact facts were used").
 *
 * KNOWN LIMITATION (documented per the task's own guidance, not silently
 * shipped as a surprise): fact ids are assigned by GLOBAL SEQUENTIAL
 * position (`F1, F2, F3, ...`) across the whole sorted-section walk, not by
 * any content-derived stable key. IDs are stable across repeated calls on
 * an UNCHANGED profile (same sections, same content, same order in →
 * same ids out — that's what determinism requires and what's tested).
 * They are NOT stable across a content edit: adding, removing, or
 * reordering a section or a bullet shifts every fact id after the change
 * point. A document generated against `F7` before an edit may find `F7`
 * means something else after — this is why `DocumentVersion.profileFactsHash`
 * exists: it lets the system detect "the fact list changed" and treat any
 * previously-generated document as stale rather than silently
 * misattributing a claim to the wrong (renumbered) fact.
 */
export function compileFactList(profile: CareerProfile): Fact[] {
  const orderedSections = [...profile.sections].sort((a, b) => a.id.localeCompare(b.id));

  const facts: Fact[] = [];
  let n = 0;
  for (const section of orderedSections) {
    for (const text of factTextsForSection(section.kind, section.content)) {
      n += 1;
      facts.push({ id: `F${n}`, sectionId: section.id, text });
    }
  }
  return facts;
}

/**
 * One text per fact for a given section, in the section's own stable
 * (array-index) order. Every kind returns at least one string (task 037
 * acceptance: "every ProfileSection kind produces at least one fact") —
 * kinds with a bullet/skill/detail array produce one fact per entry;
 * kinds without one (certification, summary) or with an empty optional
 * array (education with no `details`, experience/project with no bullets)
 * fall back to a single fact synthesized from the section's own fields.
 */
function factTextsForSection(kind: ProfileSectionKind, content: ProfileSectionContent): string[] {
  switch (kind) {
    case 'experience': {
      const c = content as ExperienceContent;
      const context = experienceContext(c);
      return c.bullets.length > 0 ? c.bullets.map((b) => `${b} — ${context}`) : [context];
    }
    case 'education': {
      const c = content as EducationContent;
      const context = educationContext(c);
      const details = c.details ?? [];
      return details.length > 0 ? details.map((d) => `${d} — ${context}`) : [context];
    }
    case 'project': {
      const c = content as ProjectContent;
      const context = `Project: ${c.name}${c.description ? ` — ${c.description}` : ''}`;
      return c.bullets.length > 0 ? c.bullets.map((b) => `${b} — ${context}`) : [context];
    }
    case 'skill_group': {
      // Domain-validated non-empty (ProfileSection.create rejects an empty
      // skills array), so this is always at least one fact.
      const c = content as SkillGroupContent;
      return c.skills.map((s) => `${s} (${c.groupName})`);
    }
    case 'certification': {
      const c = content as CertificationContent;
      const issued = c.issuedDate ? `, issued ${c.issuedDate}` : '';
      return [`${c.name}, issued by ${c.issuer}${issued}`];
    }
    case 'summary': {
      const c = content as SummaryContent;
      return [c.text];
    }
  }
}

function experienceContext(c: ExperienceContent): string {
  return `${c.title} at ${c.organization}, ${c.startDate}–${c.endDate ?? 'present'}`;
}

function educationContext(c: EducationContent): string {
  return `${c.credential}, ${c.institution}, ${c.startDate}–${c.endDate ?? 'present'}`;
}
