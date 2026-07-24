import PDFDocument from 'pdfkit';
import type {
  DocumentContent,
  ResumeDocumentContent,
  CoverLetterDocumentContent,
  OtherDocumentContent,
} from '@careerpilot/domain';
import type { RenderTemplate } from '@careerpilot/application';
import { styleFor, type RenderStyle } from './render-style.js';

/**
 * Fixed, not `new Date()` — pins the one source of run-to-run byte
 * variance we control. Raw PDF bytes are still NOT guaranteed identical
 * across runs regardless (pdfkit embeds a random trailer `/ID` via
 * `crypto.randomBytes`, independent of content or this timestamp) — see
 * `document-render.test.ts`'s determinism test, which diffs EXTRACTED TEXT
 * instead, exactly the "diff-stable" alternative task 024's acceptance
 * criterion allows. Pinning this costs nothing and removes one variable.
 */
const FIXED_TIMESTAMP = new Date('2024-01-01T00:00:00.000Z');

export function renderPdf(content: DocumentContent, template: RenderTemplate): Promise<Buffer> {
  const style = styleFor(template);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 54, autoFirstPage: true });
    doc.info.CreationDate = FIXED_TIMESTAMP;
    doc.info.ModDate = FIXED_TIMESTAMP;
    doc.info.Producer = 'CareerPilot';
    doc.info.Creator = 'CareerPilot';

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    switch (content.kind) {
      case 'resume':
        renderResume(doc, content, style);
        break;
      case 'cover_letter':
        renderCoverLetter(doc, content, style);
        break;
      case 'other':
        renderOther(doc, content, style);
        break;
    }

    doc.end();
  });
}

function renderResume(doc: PDFKit.PDFDocument, content: ResumeDocumentContent, style: RenderStyle): void {
  doc.font(style.pdfFontBold).fontSize(style.nameSize).text(content.contact.name);

  const contactLine = [content.contact.email, content.contact.phone, content.contact.location]
    .filter((v): v is string => Boolean(v))
    .join('   |   ');
  doc.font(style.pdfFontRegular).fontSize(style.bodySize);
  if (contactLine) doc.text(contactLine);
  if (content.contact.links && content.contact.links.length > 0) doc.text(content.contact.links.join('   |   '));
  doc.moveDown();

  if (content.summary) {
    doc.font(style.pdfFontRegular).fontSize(style.bodySize).text(content.summary);
    doc.moveDown();
  }

  for (const section of content.sections) {
    doc.font(style.pdfFontBold).fontSize(style.headingSize).text(section.heading.toUpperCase());
    doc.moveDown(0.25);

    for (const entry of section.entries) {
      doc.font(style.pdfFontBold).fontSize(style.bodySize).text(entry.title);
      if (entry.subtitle) doc.font(style.pdfFontRegular).fontSize(style.bodySize).text(entry.subtitle);
      if (entry.dateRange) doc.font(style.pdfFontRegular).fontSize(style.bodySize - 1).text(entry.dateRange);
      for (const bullet of entry.bullets) {
        doc.font(style.pdfFontRegular).fontSize(style.bodySize).text(`•  ${bullet}`, { indent: 12 });
      }
      doc.moveDown(0.4);
    }
    doc.moveDown(0.4);
  }
}

function renderCoverLetter(doc: PDFKit.PDFDocument, content: CoverLetterDocumentContent, style: RenderStyle): void {
  doc.font(style.pdfFontBold).fontSize(style.nameSize).text(content.contact.name);
  const contactLine = [content.contact.email, content.contact.phone].filter((v): v is string => Boolean(v)).join('   |   ');
  doc.font(style.pdfFontRegular).fontSize(style.bodySize);
  if (contactLine) doc.text(contactLine);
  doc.moveDown();

  if (content.recipient) {
    doc.text(content.recipient);
    doc.moveDown();
  }

  doc.text(content.salutation);
  doc.moveDown();

  for (const paragraph of content.bodyParagraphs) {
    doc.text(paragraph);
    doc.moveDown();
  }

  doc.text(content.closing);
}

function renderOther(doc: PDFKit.PDFDocument, content: OtherDocumentContent, style: RenderStyle): void {
  doc.font(style.pdfFontBold).fontSize(style.nameSize).text(content.title);
  doc.moveDown();
  doc.font(style.pdfFontRegular).fontSize(style.bodySize).text(content.bodyMd);
}
