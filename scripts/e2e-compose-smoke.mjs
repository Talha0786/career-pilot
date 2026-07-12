#!/usr/bin/env node
// Task 014's "e2e (compose)" pipeline stage: drives the real HTTP surface
// of the ACTUAL docker-compose stack (task 013) — Caddy -> api -> Postgres,
// and the worker/relay behind it — the same standard task 013/018 were
// verified against in a browser, automated for CI. Assumes the stack is
// already up (`docker compose up -d --build`) and reachable at BASE_URL.

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost';
const email = `smoke-${Math.random().toString(36).slice(2)}@example.com`;
const password = 'smoke-test-password-1';

function extractCookie(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0]; // "name=value" — drop attributes (Path, HttpOnly, ...)
}

async function waitForReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/auth/me`);
      if (res.status === 401) return; // API is up and answering (just unauthenticated)
    } catch {
      // connection refused while containers finish starting — keep polling
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Stack did not become reachable at ${BASE_URL} within ${timeoutMs}ms`);
}

async function main() {
  console.log(`Waiting for ${BASE_URL} to be reachable...`);
  await waitForReady();

  console.log(`Registering ${email}...`);
  const registerRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!registerRes.ok) throw new Error(`register failed: ${registerRes.status} ${await registerRes.text()}`);

  console.log('Logging in...');
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status} ${await loginRes.text()}`);
  const cookie = extractCookie(loginRes);
  if (!cookie) throw new Error('login succeeded but no session cookie was set');

  console.log('Verifying session (/auth/me)...');
  const meRes = await fetch(`${BASE_URL}/api/auth/me`, { headers: { cookie } });
  if (!meRes.ok) throw new Error(`/auth/me failed: ${meRes.status}`);
  const me = await meRes.json();
  if (me.email !== email) throw new Error(`/auth/me returned wrong user: ${JSON.stringify(me)}`);

  console.log('Pasting a job...');
  const jobRes = await fetch(`${BASE_URL}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      title: 'Smoke Test Engineer',
      company: 'Smoke Co',
      descriptionMd: 'Verifying the compose stack end-to-end from CI.',
    }),
  });
  if (!jobRes.ok) throw new Error(`create job failed: ${jobRes.status} ${await jobRes.text()}`);
  const job = await jobRes.json();

  console.log('Adding it to the pipeline (board)...');
  const appRes = await fetch(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ jobPostingId: job.jobId }),
  });
  if (!appRes.ok) throw new Error(`create application failed: ${appRes.status} ${await appRes.text()}`);

  console.log('Waiting for the board to reflect the pasted job with a terminal embedding status...');
  const deadline = Date.now() + 30_000;
  let finalStatus = null;
  while (Date.now() < deadline) {
    const boardRes = await fetch(`${BASE_URL}/api/board`, { headers: { cookie } });
    if (!boardRes.ok) throw new Error(`get board failed: ${boardRes.status}`);
    const board = await boardRes.json();
    const card = Object.values(board.columns).flat().find((c) => c.jobPostingId === job.jobId);
    if (card && (card.embeddingStatus === 'ready' || card.embeddingStatus === 'failed')) {
      finalStatus = card.embeddingStatus;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (finalStatus === null) throw new Error('job never reached a terminal embedding status within 30s');
  // 'failed' is an ACCEPTED outcome here, not a bug: this smoke run has no
  // live LLM provider configured (LLM_API_KEY unset in the compose stack by
  // default) — the point of this check is that the worker/relay/WS pipeline
  // ran end-to-end and produced a definite answer, not that the LLM call
  // itself succeeded (that's the nightly Ollama contract test's job).
  console.log(`Job reached terminal embedding status: ${finalStatus}`);

  console.log('Logging out...');
  const logoutRes = await fetch(`${BASE_URL}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  if (!logoutRes.ok) throw new Error(`logout failed: ${logoutRes.status}`);

  console.log('\nSMOKE TEST PASSED: register -> login -> paste job -> board reflects it -> logout, all against the real compose stack.');
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err.message);
  process.exit(1);
});
