import { ok, err, type Result } from '@careerpilot/domain';
import type { BrowserSubmitPort, BrowserSubmitError } from '@careerpilot/application';

/**
 * Task 053 — the HTTP half of `BrowserSubmitPort`: calls the
 * browser-runner's internal task API (task 047, service-token authed,
 * reachable only inside the compose network — `BROWSER_RUNNER_URL`
 * defaults to `http://browser-runner:7300`, the in-network service name,
 * never a host-published port).
 */
export class HttpBrowserSubmitClient implements BrowserSubmitPort {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
  ) {}

  async submit(applyTaskId: string): Promise<Result<void, BrowserSubmitError>> {
    try {
      const res = await fetch(`${this.baseUrl}/internal/tasks/${encodeURIComponent(applyTaskId)}/submit`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.serviceToken}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return err({ code: `http_${res.status}`, message: `browser-runner submit returned ${res.status}: ${body.slice(0, 500)}` });
      }
      return ok(undefined);
    } catch (e) {
      return err({ code: 'network_error', message: e instanceof Error ? e.message : String(e) });
    }
  }
}
