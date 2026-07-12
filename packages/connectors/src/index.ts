// PRODUCTION barrel — imported by the worker composition root (apps/worker),
// so it must be safe to import from a plain `node` process, not just under
// vitest. Deliberately does NOT re-export `./sdk/contract-test-kit.js`
// (it imports `vitest`'s describe/it/expect, which crashes when evaluated
// outside a real vitest worker — confirmed the hard way: importing it
// transitively from `apps/worker/src/main.ts` broke the spawned worker
// process under task 014's chaos test). Connector test files import the
// contract test-kit directly from `../../sdk/contract-test-kit.js` — they
// never needed it through this barrel.
export { ConnectorRegistry, defaultRegistry } from './sdk/registry.js';
export { htmlToText } from './sdk/html-to-text.js';
export type {
  ConnectorPort,
  ConnectorMetadata,
  ComplianceClass,
  RawJob,
  RawJobLocation,
  RawJobSalary,
  RemoteType,
  ConnectorError,
  ConnectorErrorCode,
} from '@careerpilot/application';
export * from './class-a/index.js';
