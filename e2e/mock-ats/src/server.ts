import express from 'express';

/**
 * Task 054 — "a minimal static/Express application form (mirrors a generic
 * ATS-hosted form structure, not a copy of any real platform's branded
 * UI)" (docs/05-playwright-design.md §7: "Local mock career site").
 *
 * DELIBERATE CHOICE: this form's DOM structure matches
 * `apps/browser-runner/test/fixtures/greenhouse/application-form.html`'s
 * structural signature (container id `grnhse_app`, form id
 * `application-form`, underscored field ids) — the SAME synthetic,
 * hand-built-not-scraped structure task 048 already uses, reused here
 * rather than invented a third time. This means `e2e/apply-flow.spec.ts`
 * exercises the KNOWN-ATS map path (048) end-to-end, satisfying this
 * task's acceptance criterion ("at minimum, confirm the known-ATS map path
 * is exercised") directly rather than via a coincidence. A second spec
 * variant forcing the heuristic/LLM fallback path (049/050) is explicitly
 * named a stretch goal in the task file, deferred here given time —
 * documented in tasks/054.md's Status note, not silently dropped.
 */
const app = express();
app.use(express.urlencoded({ extended: true }));

const submissions: Record<string, unknown>[] = [];

app.get('/', (_req, res) => {
  res.send(`<!doctype html>
<html>
  <head><title>Mock ATS — Software Engineer</title></head>
  <body>
    <div id="grnhse_app">
      <form id="application-form" class="application--form" method="POST" action="/submit">
        <div class="field"><label for="first_name">First Name</label><input id="first_name" name="job_application[first_name]" type="text" /></div>
        <div class="field"><label for="last_name">Last Name</label><input id="last_name" name="job_application[last_name]" type="text" /></div>
        <div class="field"><label for="email">Email</label><input id="email" name="job_application[email]" type="email" /></div>
        <div class="field"><label for="phone">Phone</label><input id="phone" name="job_application[phone]" type="tel" /></div>
        <div class="field"><label for="resume">Resume/CV</label><input id="resume" name="job_application[resume]" type="file" /></div>
        <div class="field">
          <label>Are you legally authorized to work in this country?</label>
          <input type="radio" id="work_authorization_yes" name="work_authorization" value="yes" />
          <input type="radio" id="work_authorization_no" name="work_authorization" value="no" />
        </div>
        <div class="field eeo-question">
          <label for="eeo_gender">Gender</label>
          <select id="eeo_gender" name="job_application[gender]">
            <option value="">Please select</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="decline">Decline to self-identify</option>
          </select>
        </div>
        <button type="submit" id="submit_app">Submit Application</button>
      </form>
    </div>
  </body>
</html>`);
});

app.post('/submit', (req, res) => {
  submissions.push(req.body as Record<string, unknown>);
  const jobApplication = (req.body as { job_application?: { email?: string } }).job_application;
  res.send(`<!doctype html>
<html>
  <head><title>Application received</title></head>
  <body>
    <div id="confirmation">
      <h1>Thanks for applying!</h1>
      <p data-testid="confirmed-email">${escapeHtml(jobApplication?.email ?? '')}</p>
    </div>
  </body>
</html>`);
});

/** Test-only introspection endpoint — never exists on a real ATS, exists here so the e2e spec can assert what was actually received server-side, not just what the DOM shows. */
app.get('/__test__/submissions', (_req, res) => {
  res.json(submissions);
});
app.post('/__test__/reset', (_req, res) => {
  submissions.length = 0;
  res.status(204).end();
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const PORT = Number(process.env.MOCK_ATS_PORT ?? 4100);
app.listen(PORT, () => {
  console.log(`mock-ats listening on :${PORT}`);
});
