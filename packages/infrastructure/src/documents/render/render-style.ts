import type { RenderTemplate } from '@careerpilot/application';
import { CLASSIC_STYLE } from './template-classic.js';
import { MODERN_STYLE } from './template-modern.js';

/**
 * Exactly 2 templates ship (task 024 scope guard) — this is a closed set,
 * not an extension point. `pdfFont*` are pdfkit's built-in Type1 standard
 * font names (no embedding needed, keeps output small and dependency-free);
 * `docxFontFamily` is a real font family name Word resolves at open time.
 */
export interface RenderStyle {
  readonly name: RenderTemplate;
  readonly pdfFontRegular: string;
  readonly pdfFontBold: string;
  readonly docxFontFamily: string;
  readonly nameSize: number;
  readonly headingSize: number;
  readonly bodySize: number;
}

export function styleFor(template: RenderTemplate): RenderStyle {
  return template === 'modern' ? MODERN_STYLE : CLASSIC_STYLE;
}
