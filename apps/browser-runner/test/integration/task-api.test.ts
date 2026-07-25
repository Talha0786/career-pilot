import { describe, it, expect, afterAll } from 'vitest';
import { buildTaskApi } from '../../src/task-api.js';

/**
 * Task 047 — auth behavior of the internal task API, via Fastify's
 * `inject()` (no real socket bind needed). Deliberately does NOT exercise
 * `/internal/smoke/browser` here — that route launches a real Chromium
 * process, which requires Playwright's browser binaries to be installed
 * (`npx playwright install --with-deps chromium`); this generic vitest
 * integration container doesn't have them, and installing them just for
 * this one assertion would be redundant with the REAL proof (task 047's
 * other acceptance criterion): building `apps/browser-runner/Dockerfile`
 * and hitting the running container's `/internal/smoke/browser` over the
 * compose network, which is what "Docker: docker compose up -d --build,
 * confirm browser-runner healthy" in this task's Status note actually
 * verifies. `browser-smoke.spec.ts` (Playwright, same package) is the
 * dedicated Chromium-launch proof, run against the built image or any
 * environment with the binaries installed.
 */
describe('browser-runner internal task API — auth (task 047)', () => {
  const app = buildTaskApi({ serviceToken: 'test-service-token' });
  afterAll(async () => app.close());

  it('GET /healthz requires no auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /internal/ping without a token is rejected', async () => {
    const res = await app.inject({ method: 'GET', url: '/internal/ping' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /internal/ping with the WRONG token is rejected', async () => {
    const res = await app.inject({
      method: 'GET', url: '/internal/ping',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /internal/ping with the correct service token succeeds', async () => {
    const res = await app.inject({
      method: 'GET', url: '/internal/ping',
      headers: { authorization: 'Bearer test-service-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pong: true });
  });
});
