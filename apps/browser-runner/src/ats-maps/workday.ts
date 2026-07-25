import type { Page } from 'playwright';
import type { AtsMap } from './ats-map.js';

export const workdayMap: AtsMap = {
  atsKey: 'workday',
  version: '2026.07.1',
  selectors: {
    firstName: { selector: '[data-automation-id="legalNameSection_firstName_input"]', neverAutoFill: false },
    lastName: { selector: '[data-automation-id="legalNameSection_lastName_input"]', neverAutoFill: false },
    email: { selector: '[data-automation-id="email_input"]', neverAutoFill: false },
    phone: { selector: '[data-automation-id="phone-number_input"]', neverAutoFill: false },
    resumeUpload: { selector: '[data-automation-id="file-upload-input"]', neverAutoFill: false },
    workAuthorization: { selector: '[data-automation-id^="workAuthorization_"]', neverAutoFill: false },
    sponsorshipRequired: { selector: '[data-automation-id^="sponsorshipRequired_"]', neverAutoFill: false },
    eeoGender: { selector: '[data-automation-id="gender_input"]', neverAutoFill: true },
    eeoVeteranStatus: { selector: '[data-automation-id="veteranStatus_input"]', neverAutoFill: true },
  },
  submitSelector: '[data-automation-id="bottom-navigation-next-button"]',
  async detect(page: Page): Promise<boolean> {
    const [flow, form] = await Promise.all([
      page.locator('[data-automation-id="applyFlowPage"]').count(),
      page.locator('form[data-automation-id="applyFlowForm"]').count(),
    ]);
    return flow > 0 && form > 0;
  },
};
