import type { RenderStyle } from './render-style.js';

/** Serif, traditional single-column layout — the conservative default. */
export const CLASSIC_STYLE: RenderStyle = {
  name: 'classic',
  pdfFontRegular: 'Times-Roman',
  pdfFontBold: 'Times-Bold',
  docxFontFamily: 'Times New Roman',
  nameSize: 22,
  headingSize: 13,
  bodySize: 11,
};
