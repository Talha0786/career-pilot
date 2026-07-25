import type { Page } from 'playwright';
import type { AtsMap } from './ats-map.js';

export const leverMap: AtsMap = {
  atsKey: 'lever',
  version: '2026.07.1',
  selectors: {
    firstName: { selector: '[data-qa="input-first-name"]', neverAutoFill: false },
    lastName: { selector: '[data-qa="input-last-name"]', neverAutoFill: false },
    email: { selector: '[data-qa="input-email"]', neverAutoFill: false },
    phone: { selector: '[data-qa="input-phone"]', neverAutoFill: false },
    resumeUpload: { selector: '[data-qa="input-resume"]', neverAutoFill: false },
    linkedinUrl: { selector: '[data-qa="input-urls_linkedin"]', neverAutoFill: false },
    portfolioUrl: { selector: '[data-qa="input-urls_portfolio"]', neverAutoFill: false },
    eeoGender: { selector: '[data-qa="select-eeo-gender"]', neverAutoFill: true },
    eeoVeteranStatus: { selector: '[data-qa="select-eeo-veteran"]', neverAutoFill: true },
  },
  submitSelector: '[data-qa="btn-submit"]',
  async detect(page: Page): Promise<boolean> {
    const [form, submit] = await Promise.all([
      page.locator('form[data-qa="application-form"]').count(),
      page.locator('.posting-btn-submit').count(),
    ]);
    return form > 0 && submit > 0;
  },
};
