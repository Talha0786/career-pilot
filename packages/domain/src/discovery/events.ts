export const DISCOVERY_EVENTS = {
  JOB_POSTED: 'discovery.job_posted',
} as const;

export type DiscoveryEventType =
  (typeof DISCOVERY_EVENTS)[keyof typeof DISCOVERY_EVENTS];
