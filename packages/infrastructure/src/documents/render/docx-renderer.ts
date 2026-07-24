import { Document, Packer, Paragraph, TextRun } from 'docx';
import type {
  DocumentContent,
  ResumeDocumentContent,
  CoverLetterDocumentContent,
  OtherDocumentContent,
} from '@careerpilot/domain';
import type { RenderTemplate } from '@careerpilot/application';
import { styleFor, type RenderStyle } from './render-style.js';

/**
 * NOTE on determinism: unlike `pdf-renderer.ts`, this `docx` version's
 * `IPropertiesOptions` has no `created`/`modified` field to pin, so raw
 * DOCX bytes are not guaranteed byte-identical across runs (zip-internal
 * bookkeeping). Task 024's golden-file tests diff EXTRACTED TEXT for DOCX
 * specifically for this reason — see document-render.test.ts — which IS
 * guaranteed stable and is what the acceptance criterion's "diff-stable"
 * wording is for.
 */
export async function renderDocx(content: DocumentContent, template: RenderTemplate): Promise<Buffer> {
  const style = styleFor(template);
  const children = buildParagraphs(content, style);

  const doc = new Document({
    creator: 'CareerPilot',
    title: titleFor(content),
    styles: {
      default: {
        document: { run: { font: style.docxFontFamily, size: style.bodySize * 2 } }, // docx sizes are in half-points
      },
    },
    sections: [{ children }],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

function titleFor(content: DocumentContent): string {
  switch (content.kind) {
    case 'resume':
      return `${content.contact.name} — Resume`;
    case 'cover_letter':
      return `${content.contact.name} — Cover Letter`;
    case 'other':
      return content.title;
  }
}

function buildParagraphs(content: DocumentContent, style: RenderStyle): Paragraph[] {
  switch (content.kind) {
    case 'resume':
      return resumeParagraphs(content, style);
    case 'cover_letter':
      return coverLetterParagraphs(content, style);
    case 'other':
      return otherParagraphs(content, style);
  }
}

function heading(text: string, sizePt: number, bold = true): Paragraph {
  return new Paragraph({
    spacing: { before: 200, after: 100 },
    children: [new TextRun({ text, bold, size: sizePt * 2 })],
  });
}
function body(text: string, sizePt: number): Paragraph {
  return new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text, size: sizePt * 2 })] });
}
function bullet(text: string, sizePt: number): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 40 },
    children: [new TextRun({ text, size: sizePt * 2 })],
  });
}

function resumeParagraphs(content: ResumeDocumentContent, style: RenderStyle): Paragraph[] {
  const paragraphs: Paragraph[] = [heading(content.contact.name, style.nameSize, true)];

  const contactLine = [content.contact.email, content.contact.phone, content.contact.location]
    .filter((v): v is string => Boolean(v))
    .join('   |   ');
  if (contactLine) paragraphs.push(body(contactLine, style.bodySize));
  if (content.contact.links && content.contact.links.length > 0) {
    paragraphs.push(body(content.contact.links.join('   |   '), style.bodySize));
  }

  if (content.summary) paragraphs.push(body(content.summary, style.bodySize));

  for (const section of content.sections) {
    paragraphs.push(heading(section.heading.toUpperCase(), style.headingSize, true));
    for (const entry of section.entries) {
      paragraphs.push(heading(entry.title, style.bodySize, true));
      if (entry.subtitle) paragraphs.push(body(entry.subtitle, style.bodySize));
      if (entry.dateRange) paragraphs.push(body(entry.dateRange, style.bodySize - 1));
      for (const b of entry.bullets) paragraphs.push(bullet(b, style.bodySize));
    }
  }

  return paragraphs;
}

function coverLetterParagraphs(content: CoverLetterDocumentContent, style: RenderStyle): Paragraph[] {
  const paragraphs: Paragraph[] = [heading(content.contact.name, style.nameSize, true)];

  const contactLine = [content.contact.email, content.contact.phone].filter((v): v is string => Boolean(v)).join('   |   ');
  if (contactLine) paragraphs.push(body(contactLine, style.bodySize));

  if (content.recipient) paragraphs.push(body(content.recipient, style.bodySize));
  paragraphs.push(body(content.salutation, style.bodySize));
  for (const p of content.bodyParagraphs) paragraphs.push(body(p, style.bodySize));
  paragraphs.push(body(content.closing, style.bodySize));

  return paragraphs;
}

function otherParagraphs(content: OtherDocumentContent, style: RenderStyle): Paragraph[] {
  return [heading(content.title, style.nameSize, true), body(content.bodyMd, style.bodySize)];
}
