import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPdf } from '../../src/documents/render/pdf-renderer.js';
import { renderDocx } from '../../src/documents/render/docx-renderer.js';
import { DocumentRenderer } from '../../src/documents/render/document-renderer.js';
import { extractPdfText } from '../../src/parsing/pdf-extractor.js';
import { extractDocxText } from '../../src/parsing/docx-extractor.js';
import { isOk } from '@careerpilot/domain';
import type { ResumeDocumentContent, CoverLetterDocumentContent } from '@careerpilot/domain';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/documents');

/**
 * Golden-file comparison via TEXT EXTRACTION, not raw bytes — task 024's
 * acceptance criterion explicitly allows "visual or text-extraction diff,
 * whichever is more stable in CI," and text extraction sidesteps PDF/DOCX
 * container-format noise (font subsetting internals, zip member ordering)
 * that has nothing to do with whether the render is CORRECT. Reuses the
 * task 023 extractors — the same code that will read these files back in
 * production, so this test is also a real extractor round-trip proof.
 *
 * Set UPDATE_GOLDEN=1 to (re)write the fixture from actual output, the same
 * pattern most golden-file setups use — never do this without reading the
 * diff first.
 */
function assertMatchesGolden(name: string, actual: string): void {
  const fixturePath = path.join(FIXTURES_DIR, name);
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(fixturePath)) {
    writeFileSync(fixturePath, actual);
  }
  const expected = readFileSync(fixturePath, 'utf8');
  expect(actual).toBe(expected);
}

const resumeContent: ResumeDocumentContent = {
  schemaVersion: 1,
  kind: 'resume',
  contact: {
    name: 'Jane Smith',
    email: 'jane.smith@example.com',
    phone: '555-123-4567',
    location: 'Austin, TX',
  },
  summary: 'Backend engineer with 8 years of experience building distributed systems.',
  sections: [
    {
      heading: 'Experience',
      entries: [
        {
          title: 'Senior Software Engineer',
          subtitle: 'Acme Corp',
          dateRange: 'Jan 2020 - Present',
          bullets: ['Led migration of the payments service', 'Reduced p99 latency by 40%'],
        },
      ],
    },
    {
      heading: 'Education',
      entries: [
        { title: 'State University', subtitle: 'B.S. Computer Science', dateRange: '2012 - 2016', bullets: [] },
      ],
    },
  ],
};

const coverLetterContent: CoverLetterDocumentContent = {
  schemaVersion: 1,
  kind: 'cover_letter',
  contact: { name: 'Jane Smith', email: 'jane.smith@example.com' },
  recipient: 'Hiring Manager, Acme Corp',
  salutation: 'Dear Hiring Manager,',
  bodyParagraphs: [
    'I am writing to express my interest in the Senior Software Engineer role.',
    'In my current role I led the migration of our payments service to an event-driven architecture.',
  ],
  closing: 'Sincerely, Jane Smith',
};

describe('Document rendering — golden-file text-extraction round trip (task 024)', () => {
  it.each(['classic', 'modern'] as const)('renders resume PDF (%s template) matching the golden extracted text', async (template) => {
    const bytes = await renderPdf(resumeContent, template);
    const extracted = await extractPdfText(bytes);
    expect(isOk(extracted)).toBe(true);
    if (isOk(extracted)) assertMatchesGolden(`resume-${template}.pdf.txt`, extracted.value);
  });

  it.each(['classic', 'modern'] as const)('renders resume DOCX (%s template) matching the golden extracted text', async (template) => {
    const bytes = await renderDocx(resumeContent, template);
    const extracted = await extractDocxText(bytes);
    expect(isOk(extracted)).toBe(true);
    if (isOk(extracted)) assertMatchesGolden(`resume-${template}.docx.txt`, extracted.value);
  });

  it('renders a cover letter PDF matching the golden extracted text', async () => {
    const bytes = await renderPdf(coverLetterContent, 'classic');
    const extracted = await extractPdfText(bytes);
    expect(isOk(extracted)).toBe(true);
    if (isOk(extracted)) assertMatchesGolden('cover-letter-classic.pdf.txt', extracted.value);
  });

  it('renders a cover letter DOCX matching the golden extracted text', async () => {
    const bytes = await renderDocx(coverLetterContent, 'modern');
    const extracted = await extractDocxText(bytes);
    expect(isOk(extracted)).toBe(true);
    if (isOk(extracted)) assertMatchesGolden('cover-letter-modern.docx.txt', extracted.value);
  });
});

describe('Document rendering — determinism (task 024 acceptance criterion)', () => {
  it('renders extraction-stable PDFs for the same input across repeated calls', async () => {
    // pdfkit embeds a random trailer /ID per render (crypto.randomBytes,
    // not derived from content or the pinned CreationDate/ModDate), so raw
    // bytes are NOT identical across runs even with metadata pinned. Same
    // "diff-stable, not byte-identical" reasoning as the DOCX case below —
    // both are the extracted-text contract, which the acceptance criterion
    // explicitly allows ("byte-identical OR diff-stable, whichever is more
    // stable in CI") and which IS what golden-file tests above actually check.
    const a = await renderPdf(resumeContent, 'classic');
    const b = await renderPdf(resumeContent, 'classic');
    const textA = await extractPdfText(a);
    const textB = await extractPdfText(b);
    expect(isOk(textA) && isOk(textB)).toBe(true);
    if (isOk(textA) && isOk(textB)) expect(textA.value).toBe(textB.value);
  });

  it('renders extraction-stable DOCX for the same input across repeated calls', async () => {
    // DOCX (zip container) byte-identity is not guaranteed across runs even
    // with fixed metadata (zip-internal bookkeeping); extracted text is the
    // contract that actually matters and IS guaranteed stable.
    const a = await renderDocx(resumeContent, 'modern');
    const b = await renderDocx(resumeContent, 'modern');
    const textA = await extractDocxText(a);
    const textB = await extractDocxText(b);
    expect(isOk(textA) && isOk(textB)).toBe(true);
    if (isOk(textA) && isOk(textB)) expect(textA.value).toBe(textB.value);
  });
});

describe('DocumentRenderer — dispatch by format (task 024)', () => {
  const renderer = new DocumentRenderer();

  it('routes pdf format to the PDF renderer', async () => {
    const bytes = await renderer.render(resumeContent, 'pdf', 'classic');
    const extracted = await extractPdfText(bytes);
    expect(isOk(extracted)).toBe(true);
    if (isOk(extracted)) expect(extracted.value).toContain('Jane Smith');
  });

  it('routes docx format to the DOCX renderer', async () => {
    const bytes = await renderer.render(resumeContent, 'docx', 'modern');
    const extracted = await extractDocxText(bytes);
    expect(isOk(extracted)).toBe(true);
    if (isOk(extracted)) expect(extracted.value).toContain('Jane Smith');
  });
});
