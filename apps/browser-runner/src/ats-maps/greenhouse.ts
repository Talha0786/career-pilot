import type { Page } from 'playwright';
import type { AtsMap } from './ats-map.js';

export const greenhouseMap: AtsMap = {
  atsKey: 'greenhouse',
  version: '2026.07.1',
  selectors: {
    firstName: { selector: '#first_name', neverAutoFill: false },
    lastName: { selector: '#last_name', neverAutoFill: false },
    email: { selector: '#email', neverAutoFill: false },
    phone: { selector: '#phone', neverAutoFill: false },
    resumeUpload: { selector: '#resume', neverAutoFill: false },
    coverLetterUpload: { selector: '#cover_letter', neverAutoFill: false },
    linkedinUrl: { selector: '#job_application_answers_attributes_0_text_value', neverAutoFill: false },
    workAuthorization: { selector: 'input[name="work_authorization"]', neverAutoFill: false },
    eeoGender: { selector: '#eeo_gender', neverAutoFill: true },
    eeoRace: { selector: '#eeo_race', neverAutoFill: true },
  },
  submitSelector: '#submit_app',
  async detect(page: Page): Promise<boolean> {
    const [app, form] = await Promise.all([
      page.locator('#grnhse_app').count(),
      page.locator('#application-form').count(),
    ]);
    return app > 0 && form > 0;
  },
};
