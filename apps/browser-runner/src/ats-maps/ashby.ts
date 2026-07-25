import type { Page } from 'playwright';
import type { AtsMap } from './ats-map.js';

export const ashbyMap: AtsMap = {
  atsKey: 'ashby',
  version: '2026.07.1',
  selectors: {
    firstName: { selector: '[data-testid="field-input-name_first"]', neverAutoFill: false },
    lastName: { selector: '[data-testid="field-input-name_last"]', neverAutoFill: false },
    email: { selector: '[data-testid="field-input-email"]', neverAutoFill: false },
    phone: { selector: '[data-testid="field-input-phone"]', neverAutoFill: false },
    resumeUpload: { selector: '[data-testid="field-input-resume"]', neverAutoFill: false },
    workAuthorization: { selector: '[data-testid^="field-input-work_auth-"]', neverAutoFill: false },
    eeoGender: { selector: '[data-testid="field-input-eeo_gender"]', neverAutoFill: true },
    eeoDisabilityStatus: { selector: '[data-testid="field-input-eeo_disability"]', neverAutoFill: true },
  },
  submitSelector: '[data-testid="btn-submit-application"]',
  async detect(page: Page): Promise<boolean> {
    const [root, form] = await Promise.all([
      page.locator('#ashby-embed-root').count(),
      page.locator('form[data-testid="application-form"]').count(),
    ]);
    return root > 0 && form > 0;
  },
};
