import type {
  ProfileSectionKind,
  ProfileSectionContent,
  ExperienceContent,
  EducationContent,
  ProjectContent,
  SkillGroupContent,
  CertificationContent,
} from '@careerpilot/domain';

/**
 * Resume field mapper (task 023) — extracted resume text → a structured
 * profile draft. This is deliberately a HEURISTIC, deterministic parser
 * (regex + section-header detection), not an LLM call for the core
 * extraction: this sandbox has no live LLM reachable (same constraint
 * already documented in tasks 009/010/011 — "no live model reachable
 * here"), and the accuracy benchmark (docs/eval/resume-import-benchmark)
 * needs a reproducible, network-free number, not one that varies by
 * whichever model happens to be configured.
 *
 * `mapResumeTextToDraft` is exported for the benchmark script and for
 * `import-resume`'s worker handler to call directly. An LLM-assisted
 * refinement hook (`refineWithLlm`) is wired separately (see
 * `llm-assisted-refiner.ts`) through the SAME `GuardedLlmPort` every other
 * LLM call in this codebase goes through (budget-checked, `ai_invocations`-
 * audited, `parsing` context) — it's additive, never required, and the
 * benchmark is run WITHOUT it so the reported number reflects what ships
 * key-free by default (ADR-006's "local-default" posture).
 */

export interface DraftField<T> {
  readonly value: T;
  /** 0..1 — how confident the heuristic is. Surfaced by task 025's UI so low-confidence fields are cheap to review. */
  readonly confidence: number;
}

export interface ContactDraft {
  readonly name: DraftField<string | null>;
  readonly email: DraftField<string | null>;
  readonly phone: DraftField<string | null>;
}

export interface DraftSection {
  readonly kind: ProfileSectionKind;
  readonly content: ProfileSectionContent;
  readonly confidence: number;
}

export interface ResumeImportDraft {
  readonly contact: ContactDraft;
  readonly summary: DraftField<string | null>;
  readonly sections: readonly DraftSection[];
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(\+?\d[\d\-.\s()]{7,}\d)/;
// A single date token in any of three common resume forms: "Jan 2020" /
// "January 2020", bare "2020", or numeric "03/2019" / "03-2019". Numeric
// comes before bare-year in the alternation so "03/2019" is consumed as ONE
// token — otherwise the engine would only pick up the trailing "2019" and
// then fail to find a second token immediately after (the "08" of a
// following "08/2022" isn't a standalone 4-digit run), silently dropping
// the whole range. Order matters here, not just for tidiness.
const DATE_TOKEN = String.raw`[A-Za-z]+\.?\s+\d{4}|\d{1,2}[/-]\d{4}|\d{4}`;
const DATE_RANGE_RE = new RegExp(
  `(?:${DATE_TOKEN})\\s*(?:-|–|—|to)\\s*(?:${DATE_TOKEN}|present|current)`,
  'i',
);
// Capturing variant of the same pattern, used where the two token values are needed.
const DATE_RANGE_CAPTURE_RE = new RegExp(
  `(${DATE_TOKEN})\\s*(?:-|–|—|to)\\s*(${DATE_TOKEN}|present|current)`,
  'i',
);
const BULLET_LINE_RE = /^[\s]*[-•*▪◦]\s*(.+)$/;

const SECTION_HEADERS: { kind: ProfileSectionKind | 'contact'; re: RegExp }[] = [
  { kind: 'summary', re: /^(professional\s+)?(summary|objective|profile)s?\s*:?$/i },
  { kind: 'experience', re: /^(work\s+|professional\s+)?experience\s*:?$|^employment\s+history\s*:?$/i },
  { kind: 'education', re: /^education\s*(and\s+training)?\s*:?$/i },
  { kind: 'project', re: /^projects?\s*:?$/i },
  { kind: 'skill_group', re: /^(technical\s+)?skills\s*:?$|^core\s+competencies\s*:?$/i },
  { kind: 'certification', re: /^certifications?\s*:?$|^licenses?\s*(and\s+certifications?)?\s*:?$/i },
];

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function detectHeader(line: string): ProfileSectionKind | null {
  for (const h of SECTION_HEADERS) {
    if (h.re.test(line)) return h.kind === 'contact' ? null : h.kind;
  }
  return null;
}

/** Splits the resume into a contact-header block + one block per detected section. */
function segment(lines: string[]): { header: string[]; blocks: { kind: ProfileSectionKind; lines: string[] }[] } {
  const blocks: { kind: ProfileSectionKind; lines: string[] }[] = [];
  const header: string[] = [];
  let current: { kind: ProfileSectionKind; lines: string[] } | null = null;

  for (const line of lines) {
    const kind = detectHeader(line);
    if (kind) {
      if (current) blocks.push(current);
      current = { kind, lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else header.push(line);
  }
  if (current) blocks.push(current);
  return { header, blocks };
}

function extractContact(headerLines: string[], allLines: string[]): ContactDraft {
  const searchSpace = headerLines.length > 0 ? headerLines : allLines.slice(0, 5);

  const emailLine = searchSpace.find((l) => EMAIL_RE.test(l));
  const email = emailLine?.match(EMAIL_RE)?.[0] ?? null;

  const phoneLine = searchSpace.find((l) => PHONE_RE.test(l) && !EMAIL_RE.test(l));
  const phone = phoneLine?.match(PHONE_RE)?.[0]?.trim() ?? null;

  // Name heuristic: first header line that isn't the email/phone line and
  // looks like "Firstname Lastname" (2-4 capitalized-ish words, no digits,
  // not a section header). Resumes overwhelmingly lead with the candidate's
  // name, so "first qualifying line" is a strong, simple prior.
  const nameLine = searchSpace.find((l) => {
    if (l === emailLine || l === phoneLine) return false;
    if (/\d/.test(l)) return false;
    if (detectHeader(l)) return false;
    const words = l.split(/\s+/).filter(Boolean);
    // Unicode-aware (\p{Lu}/\p{L}) so accented names (e.g. "Tomás", "René")
    // aren't silently dropped just because they fall outside ASCII A-Z.
    return words.length >= 2 && words.length <= 5 && words.every((w) => /^\p{Lu}[\p{L}.'-]*$/u.test(w));
  });

  return {
    name: { value: nameLine ?? null, confidence: nameLine ? 0.7 : 0 },
    email: { value: email, confidence: email ? 0.95 : 0 },
    phone: { value: phone, confidence: phone ? 0.8 : 0 },
  };
}

/**
 * Entries are
 * separated by a line that contains a date range AND is preceded by at most
 * one non-bullet "title" line since the last entry boundary. In practice,
 * resumes put one entry's title(+org) and date on adjacent lines, so we
 * scan for date-range lines as anchors and slice backward to the previous
 * anchor (or block start).
 */
function splitEntriesByDateAnchor(lines: string[]): string[][] {
  const anchorIdx: number[] = [];
  lines.forEach((l, i) => {
    if (DATE_RANGE_RE.test(l) && !BULLET_LINE_RE.test(l)) anchorIdx.push(i);
  });
  if (anchorIdx.length === 0) return lines.length > 0 ? [lines] : [];

  const entries: string[][] = [];
  let sliceStart = 0;
  for (let a = 0; a < anchorIdx.length; a++) {
    const nextAnchor = anchorIdx[a + 1];
    // Look ahead past the date line itself, up to (but not including) the
    // next anchor's title line — approximated as "one line before the next
    // date anchor," since bullets in between belong to THIS entry.
    const end = nextAnchor !== undefined ? findNextTitleBoundary(lines, anchorIdx[a]!, nextAnchor) : lines.length;
    entries.push(lines.slice(sliceStart, end));
    sliceStart = end;
  }
  return entries;
}

/**
 * Between this entry's date line and the next entry's date line, bullets
 * (`- ...`) belong to THIS entry; the first non-bullet line found is the
 * next entry's title line and becomes the new boundary.
 */
function findNextTitleBoundary(lines: string[], _thisAnchor: number, nextAnchor: number): number {
  for (let i = nextAnchor - 1; i >= 0; i--) {
    if (BULLET_LINE_RE.test(lines[i] ?? '')) continue;
    return i;
  }
  return nextAnchor;
}

function splitTitleOrg(line: string): { title: string; organization: string } {
  // Common separators resumes use between role and company.
  const seps = [' at ', ' @ ', ' | ', ' — ', ' – ', ' - ', ', '];
  for (const sep of seps) {
    const idx = line.indexOf(sep);
    if (idx > 0) {
      return { title: line.slice(0, idx).trim(), organization: line.slice(idx + sep.length).trim() };
    }
  }
  return { title: line.trim(), organization: '' };
}

function extractBullets(lines: string[]): string[] {
  return lines
    .filter((l) => BULLET_LINE_RE.test(l))
    .map((l) => l.match(BULLET_LINE_RE)?.[1]?.trim() ?? l);
}

function extractDateRange(lines: string[]): { startDate: string; endDate: string | null } | null {
  for (const line of lines) {
    const m = line.match(DATE_RANGE_CAPTURE_RE);
    if (m) {
      const end = m[2]!.toLowerCase();
      return { startDate: m[1]!.trim(), endDate: end === 'present' || end === 'current' ? null : m[2]!.trim() };
    }
  }
  return null;
}

function mapExperienceBlock(lines: string[]): DraftSection[] {
  const entries = splitEntriesByDateAnchor(lines);
  return entries.map((entryLines): DraftSection => {
    const titleLine = entryLines.find((l) => !BULLET_LINE_RE.test(l) && !DATE_RANGE_RE.test(l)) ?? entryLines[0] ?? '';
    const { title, organization } = splitTitleOrg(titleLine);
    const dates = extractDateRange(entryLines);
    const bullets = extractBullets(entryLines);

    let confidence = 0.3; // base: we at least found an entry
    if (organization) confidence += 0.25;
    if (dates) confidence += 0.25;
    if (bullets.length > 0) confidence += 0.2;

    const content: ExperienceContent = {
      schemaVersion: 1,
      title: title || 'Unknown role',
      organization: organization || 'Unknown organization',
      startDate: dates?.startDate ?? '',
      endDate: dates?.endDate ?? null,
      bullets,
    };
    return { kind: 'experience', content, confidence: Math.min(1, confidence) };
  });
}

function mapEducationBlock(lines: string[]): DraftSection[] {
  const entries = splitEntriesByDateAnchor(lines);
  return entries.map((entryLines): DraftSection => {
    const titleLine = entryLines.find((l) => !BULLET_LINE_RE.test(l) && !DATE_RANGE_RE.test(l)) ?? entryLines[0] ?? '';
    const { title: institution, organization: credential } = splitTitleOrg(titleLine);
    const dates = extractDateRange(entryLines);
    const details = extractBullets(entryLines);

    let confidence = 0.3;
    if (credential) confidence += 0.3;
    if (dates) confidence += 0.25;
    if (details.length > 0) confidence += 0.15;

    const content: EducationContent = {
      schemaVersion: 1,
      institution: institution || 'Unknown institution',
      credential: credential || 'Unknown credential',
      startDate: dates?.startDate ?? '',
      endDate: dates?.endDate ?? null,
      ...(details.length > 0 ? { details } : {}),
    };
    return { kind: 'education', content, confidence: Math.min(1, confidence) };
  });
}

/**
 * A new project entry starts at a non-bullet line that arrives AFTER we've
 * already seen at least one bullet in the current entry — i.e. once bullets
 * have started, the next non-bullet line is the NEXT project's title, not
 * more detail on this one. This is what lets a "title line, then a
 * description line, THEN bullets" shape (very common) stay together as one
 * entry instead of being split apart on the description line.
 */
function mapProjectBlock(lines: string[]): DraftSection[] {
  const entries: string[][] = [];
  let current: string[] = [];
  let currentHasBullet = false;
  for (const line of lines) {
    const isBullet = BULLET_LINE_RE.test(line);
    if (!isBullet && currentHasBullet && current.length > 0) {
      entries.push(current);
      current = [];
      currentHasBullet = false;
    }
    if (isBullet) currentHasBullet = true;
    current.push(line);
  }
  if (current.length > 0) entries.push(current);

  return entries.map((entryLines): DraftSection => {
    const nameLine = entryLines[0] ?? '';
    const bullets = extractBullets(entryLines);
    const descriptionLine = entryLines.find((l) => l !== nameLine && !BULLET_LINE_RE.test(l));

    let confidence = 0.4;
    if (bullets.length > 0) confidence += 0.3;
    if (descriptionLine) confidence += 0.3;

    const content: ProjectContent = {
      schemaVersion: 1,
      name: nameLine || 'Untitled project',
      description: descriptionLine ?? '',
      bullets,
    };
    return { kind: 'project', content, confidence: Math.min(1, confidence) };
  });
}

function mapSkillBlock(lines: string[]): DraftSection[] {
  const skills = lines
    .join(', ')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length < 60);

  if (skills.length === 0) return [];

  const content: SkillGroupContent = { schemaVersion: 1, groupName: 'Skills', skills };
  return [{ kind: 'skill_group', content, confidence: skills.length >= 3 ? 0.85 : 0.5 }];
}

function mapCertificationBlock(lines: string[]): DraftSection[] {
  return lines
    .filter((l) => l.length > 0)
    .map((line): DraftSection => {
      const { title: name, organization: issuer } = splitTitleOrg(line);
      const content: CertificationContent = {
        schemaVersion: 1,
        name: name || line,
        issuer: issuer || 'Unknown issuer',
      };
      return { kind: 'certification', content, confidence: issuer ? 0.75 : 0.45 };
    });
}

function mapSummaryBlock(lines: string[]): DraftField<string | null> {
  const text = lines.join(' ').trim();
  if (text.length === 0) return { value: null, confidence: 0 };
  return { value: text, confidence: 0.7 };
}

/** The entry point: raw extracted resume text -> a structured, confidence-scored draft. */
export function mapResumeTextToDraft(text: string): ResumeImportDraft {
  const lines = splitLines(text);
  const { header, blocks } = segment(lines);
  const contact = extractContact(header, lines);

  let summary: DraftField<string | null> = { value: null, confidence: 0 };
  const sections: DraftSection[] = [];

  for (const block of blocks) {
    switch (block.kind) {
      case 'experience':
        sections.push(...mapExperienceBlock(block.lines));
        break;
      case 'education':
        sections.push(...mapEducationBlock(block.lines));
        break;
      case 'project':
        sections.push(...mapProjectBlock(block.lines));
        break;
      case 'skill_group':
        sections.push(...mapSkillBlock(block.lines));
        break;
      case 'certification':
        sections.push(...mapCertificationBlock(block.lines));
        break;
      case 'summary':
        summary = mapSummaryBlock(block.lines);
        break;
    }
  }

  return { contact, summary, sections };
}
