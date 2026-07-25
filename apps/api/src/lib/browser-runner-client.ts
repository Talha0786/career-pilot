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

export interface BrowserRunnerFieldDiffEntry {
  readonly taxonomyKey: string;
  readonly label: string;
  readonly selector: string;
  readonly mappedValue: string | null;
  readonly neverAutoFill: boolean;
  readonly confidence: number;
  readonly source: 'known_ats' | 'heuristic' | 'llm';
}

/** Task 052 — an interface (not just the concrete HTTP client below) so tests can supply a plain scripted fake, same posture as `BrowserSubmitPort`. */
export interface BrowserRunnerFieldsPort {
  getFields(applyTaskId: string): Promise<Result<BrowserRunnerFieldDiffEntry[], BrowserSubmitError>>;
}

/**
 * Task 052 — the read-side counterpart of `HttpBrowserSubmitClient`: fetches
 * the field-level review diff (ADR-003) from `apps/browser-runner`'s
 * internal task API. A read-only GET, but still goes through the same
 * service-token-gated internal boundary — `apps/api` is the only caller,
 * same as the submit path.
 */
export class HttpBrowserRunnerFieldsClient implements BrowserRunnerFieldsPort {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
  ) {}

  async getFields(applyTaskId: string): Promise<Result<BrowserRunnerFieldDiffEntry[], BrowserSubmitError>> {
    try {
      const res = await fetch(`${this.baseUrl}/internal/tasks/${encodeURIComponent(applyTaskId)}/fields`, {
        headers: { authorization: `Bearer ${this.serviceToken}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return err({ code: `http_${res.status}`, message: `browser-runner fields returned ${res.status}: ${body.slice(0, 500)}` });
      }
      const data = (await res.json()) as { fields: BrowserRunnerFieldDiffEntry[] };
      return ok(data.fields);
    } catch (e) {
      return err({ code: 'network_error', message: e instanceof Error ? e.message : String(e) });
    }
  }
}
