import type { RenderStyle } from './render-style.js';

/** Sans-serif, tighter spacing, slightly larger name treatment. */
export const MODERN_STYLE: RenderStyle = {
  name: 'modern',
  pdfFontRegular: 'Helvetica',
  pdfFontBold: 'Helvetica-Bold',
  docxFontFamily: 'Calibri',
  nameSize: 24,
  headingSize: 12,
  bodySize: 10,
};
