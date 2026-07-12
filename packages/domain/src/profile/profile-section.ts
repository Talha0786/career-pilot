import { type Result, ok, err } from '../shared/result.js';
import { type DomainError, validationFailed } from '../shared/errors.js';
import { type CareerProfileId, type ProfileSectionId, newProfileSectionId } from '../shared/ids.js';

/**
 * Closed enum (database design §2: "one row per entry — experience,
 * education, project, skill-group, certification"). Adding a kind is a
 * deliberate schema change, not a runtime free-for-all.
 */
export const PROFILE_SECTION_KINDS = [
  'experience',
  'education',
  'project',
  'skill_group',
  'certification',
  'summary',
] as const;
export type ProfileSectionKind = (typeof PROFILE_SECTION_KINDS)[number];

/**
 * Content is JSONB-per-entry (design §2 rationale: section schemas evolve
 * fast; queries are by profile, not by field). The domain still validates
 * the minimal shape per kind so a malformed section can never be persisted —
 * `schemaVersion` lets a future kind-schema migration detect old rows.
 */
export interface ExperienceContent {
  readonly schemaVersion: 1;
  readonly title: string;
  readonly organization: string;
  readonly startDate: string; // ISO yyyy-mm or yyyy-mm-dd
  readonly endDate: string | null; // null = current
  readonly location?: string | undefined;
  readonly bullets: readonly string[];
}
export interface EducationContent {
  readonly schemaVersion: 1;
  readonly institution: string;
  readonly credential: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly details?: readonly string[] | undefined;
}
export interface ProjectContent {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly description: string;
  readonly url?: string | undefined;
  readonly bullets: readonly string[];
}
export interface SkillGroupContent {
  readonly schemaVersion: 1;
  readonly groupName: string;
  readonly skills: readonly string[];
}
export interface CertificationContent {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly issuer: string;
  readonly issuedDate?: string | undefined;
}
export interface SummaryContent {
  readonly schemaVersion: 1;
  readonly text: string;
}

export type ProfileSectionContent =
  | ExperienceContent
  | EducationContent
  | ProjectContent
  | SkillGroupContent
  | CertificationContent
  | SummaryContent;

export interface ProfileSectionSnapshot {
  readonly id: ProfileSectionId;
  readonly profileId: CareerProfileId;
  readonly kind: ProfileSectionKind;
  readonly sort: number;
  readonly content: ProfileSectionContent;
}

function validateContent(
  kind: ProfileSectionKind,
  content: ProfileSectionContent,
): Result<void, DomainError> {
  const fail = (field: string) =>
    err(validationFailed(`Invalid ${kind} section content`, { field }));

  switch (kind) {
    case 'experience': {
      const c = content as ExperienceContent;
      if (!c.title?.trim()) return fail('title');
      if (!c.organization?.trim()) return fail('organization');
      if (!c.startDate?.trim()) return fail('startDate');
      return ok(undefined);
    }
    case 'education': {
      const c = content as EducationContent;
      if (!c.institution?.trim()) return fail('institution');
      if (!c.credential?.trim()) return fail('credential');
      return ok(undefined);
    }
    case 'project': {
      const c = content as ProjectContent;
      if (!c.name?.trim()) return fail('name');
      return ok(undefined);
    }
    case 'skill_group': {
      const c = content as SkillGroupContent;
      if (!c.groupName?.trim()) return fail('groupName');
      if (!Array.isArray(c.skills) || c.skills.length === 0) return fail('skills');
      return ok(undefined);
    }
    case 'certification': {
      const c = content as CertificationContent;
      if (!c.name?.trim()) return fail('name');
      if (!c.issuer?.trim()) return fail('issuer');
      return ok(undefined);
    }
    case 'summary': {
      const c = content as SummaryContent;
      if (!c.text?.trim()) return fail('text');
      return ok(undefined);
    }
  }
}

/**
 * ProfileSection — entity owned by CareerProfile (design §2). It is never
 * constructed standalone in application code; only `CareerProfile.addSection`
 * calls `ProfileSection.create`, which is what guarantees "sections belong to
 * exactly one profile" (task 019 acceptance criterion) — the profileId always
 * comes from the owning aggregate, never from caller input.
 */
export class ProfileSection {
  private constructor(
    readonly id: ProfileSectionId,
    readonly profileId: CareerProfileId,
    readonly kind: ProfileSectionKind,
    private _sort: number,
    private _content: ProfileSectionContent,
  ) {}

  static create(args: {
    profileId: CareerProfileId;
    kind: ProfileSectionKind;
    sort: number;
    content: ProfileSectionContent;
  }): Result<ProfileSection, DomainError> {
    if (!PROFILE_SECTION_KINDS.includes(args.kind)) {
      return err(validationFailed('Unknown section kind', { kind: String(args.kind) }));
    }
    const validated = validateContent(args.kind, args.content);
    if (!validated.ok) return validated;

    return ok(
      new ProfileSection(newProfileSectionId(), args.profileId, args.kind, args.sort, args.content),
    );
  }

  static fromSnapshot(s: ProfileSectionSnapshot): ProfileSection {
    return new ProfileSection(s.id, s.profileId, s.kind, s.sort, s.content);
  }

  /** Replaces content in place — still the SAME section id (an edit, not a new entry). */
  updateContent(content: ProfileSectionContent): Result<void, DomainError> {
    const validated = validateContent(this.kind, content);
    if (!validated.ok) return validated;
    this._content = content;
    return ok(undefined);
  }

  reorder(sort: number): void {
    this._sort = sort;
  }

  /** Flattened text for FTS + embedding source (design §2). */
  toContentText(): string {
    const c = this._content;
    switch (this.kind) {
      case 'experience': {
        const e = c as ExperienceContent;
        return [e.title, e.organization, e.location, ...e.bullets].filter(Boolean).join(' ');
      }
      case 'education': {
        const e = c as EducationContent;
        return [e.institution, e.credential, ...(e.details ?? [])].filter(Boolean).join(' ');
      }
      case 'project': {
        const p = c as ProjectContent;
        return [p.name, p.description, ...p.bullets].filter(Boolean).join(' ');
      }
      case 'skill_group': {
        const g = c as SkillGroupContent;
        return [g.groupName, ...g.skills].join(' ');
      }
      case 'certification': {
        const cert = c as CertificationContent;
        return [cert.name, cert.issuer].filter(Boolean).join(' ');
      }
      case 'summary':
        return (c as SummaryContent).text;
    }
  }

  get sort(): number {
    return this._sort;
  }
  get content(): ProfileSectionContent {
    return this._content;
  }

  toSnapshot(): ProfileSectionSnapshot {
    return {
      id: this.id,
      profileId: this.profileId,
      kind: this.kind,
      sort: this._sort,
      content: this._content,
    };
  }
}
