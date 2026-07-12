import type { ClockPort } from '@careerpilot/application';

/** Trivial real-time adapter for `ClockPort` — the only implementation that matters outside tests. */
export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}
