import { describe, it, expect } from 'vitest';
import {
  AddSectionRequestSchema,
  PutProfileRequestSchema,
  CareerProfileDtoSchema,
} from './profile.js';
import {
  CreateDocumentRequestSchema,
  AddDocumentVersionRequestSchema,
  DocumentContentSchema,
  DocumentDtoSchema,
} from './documents.js';

describe('profile contracts', () => {
  it('AddSectionRequest is a discriminated union on kind — content must match', () => {
    const validExperience = {
      kind: 'experience',
      content: { schemaVersion: 1, title: 'Eng', organization: 'Acme', startDate: '2020-01', endDate: null, bullets: [] },
    };
    expect(AddSectionRequestSchema.safeParse(validExperience).success).toBe(true);

    // skill_group content on an 'experience' kind must fail.
    const mismatched = { kind: 'experience', content: { schemaVersion: 1, groupName: 'x', skills: ['a'] } };
    expect(AddSectionRequestSchema.safeParse(mismatched).success).toBe(false);

    expect(AddSectionRequestSchema.safeParse({ kind: 'unknown_kind', content: {} }).success).toBe(false);
  });

  it('PutProfileRequest requires a non-empty title', () => {
    expect(PutProfileRequestSchema.safeParse({ title: 'My Career' }).success).toBe(true);
    expect(PutProfileRequestSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('CareerProfileDto round-trips a realistic payload', () => {
    const dto = {
      id: crypto.randomUUID(),
      title: 'My Career',
      summary: null,
      isActive: true,
      embeddingStatus: 'pending',
      factsHash: 'abc123',
      isEmbeddingStale: true,
      sections: [],
      createdAt: new Date().toISOString(),
    };
    expect(CareerProfileDtoSchema.safeParse(dto).success).toBe(true);
  });
});

describe('document contracts', () => {
  it('CreateDocumentRequest enforces the closed kind enum', () => {
    expect(CreateDocumentRequestSchema.safeParse({ kind: 'resume', title: 'My Resume' }).success).toBe(true);
    expect(CreateDocumentRequestSchema.safeParse({ kind: 'cv', title: 'x' }).success).toBe(false);
  });

  it('DocumentContent is a discriminated union — resume content on a cover_letter kind fails', () => {
    const resume = {
      schemaVersion: 1,
      kind: 'resume',
      contact: { name: 'Ada', email: 'ada@example.com' },
      summary: null,
      sections: [],
    };
    expect(DocumentContentSchema.safeParse(resume).success).toBe(true);

    const mismatched = { ...resume, kind: 'cover_letter' };
    expect(DocumentContentSchema.safeParse(mismatched).success).toBe(false);
  });

  it('AddDocumentVersionRequest validates content against the discriminated union', () => {
    const valid = {
      source: 'imported',
      content: {
        schemaVersion: 1,
        kind: 'cover_letter',
        contact: { name: 'Ada', email: 'ada@example.com' },
        recipient: null,
        salutation: 'Dear Hiring Manager',
        bodyParagraphs: ['Paragraph one.'],
        closing: 'Sincerely',
      },
    };
    expect(AddDocumentVersionRequestSchema.safeParse(valid).success).toBe(true);
    expect(AddDocumentVersionRequestSchema.safeParse({ source: 'imported', content: {} }).success).toBe(false);
  });

  it('DocumentDto round-trips a realistic payload including versions', () => {
    const dto = {
      id: crypto.randomUUID(),
      kind: 'resume',
      title: 'My Resume',
      currentVersionId: crypto.randomUUID(),
      deletedAt: null,
      createdAt: new Date().toISOString(),
      versions: [
        {
          id: crypto.randomUUID(),
          version: 1,
          source: 'imported',
          content: {
            schemaVersion: 1,
            kind: 'resume',
            contact: { name: 'Ada', email: 'ada@example.com' },
            summary: null,
            sections: [],
          },
          renderedPdfKey: null,
          profileFactsHash: null,
          createdAt: new Date().toISOString(),
        },
      ],
    };
    expect(DocumentDtoSchema.safeParse(dto).success).toBe(true);
  });
});
