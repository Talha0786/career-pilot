# `@careerpilot/connectors`

Job-discovery connectors and the SDK they're built on (ADR-004). This package
is infrastructure: every connector implements `ConnectorPort`
(`packages/application/src/ports/connector.port.ts`) and depends on
`@careerpilot/application` + `@careerpilot/domain` only — never the reverse.

## The four compliance classes (ADR-004)

Coverage of a job platform is delivered through exactly one of these. The
class is a hard product/legal boundary, not a style choice — see
[ADR-004](../../docs/adr/ADR-004-connector-plugin-architecture.md) for the
full reasoning (this is the LinkedIn/Indeed decision record).

| Class | What it is | Where it lives | Examples |
|---|---|---|---|
| **A — Official APIs & public feeds** | Zero legal risk: a documented public API or feed. | `src/class-a/<name>/` | Greenhouse, Lever, Ashby, USAJobs, RSS, manual paste |
| **B — User-session capture** | User-initiated, single-item, already-authenticated-browser capture. No stored credentials, no server-side fetch, no automated login. | `src/class-b/<name>/` | Browser extension / bookmarklet → `POST /api/capture` |
| **C — BYO-key licensed provider** | The user supplies their own paid API key to a licensed third-party job-data provider. Scraping/compliance liability sits with that provider under the user's contract with them. | `src/class-c/<name>/` | SerpApi Google Jobs, (future) Mantiks/Bright Data/Coresignal |
| **D — ToS-prohibited direct automation** | **NEVER first-party.** Server-side scraping or credentialed login-harvest of a platform whose ToS forbids it (LinkedIn/Indeed direct). | Nowhere. Not implemented, not documented as a recipe, not accepted in a first-party PR. | — |

`ConnectorMetadata.complianceClass` is typed `'A' \| 'B' \| 'C'` — the type
system itself refuses to let a connector declare `'D'`. The SDK does not
technically prevent a community fork from adding a Class D connector, but
this project neither ships, documents, nor endorses one.

## How to write a connector

1. Pick the correct class (above) — if you're not sure, it's not Class A.
2. Create `src/class-<x>/<your-connector>/index.ts` exporting a
   `ConnectorPort` implementation:
   - `metadata: { key, displayName, complianceClass }` — `key` must be
     globally unique (the registry rejects duplicates).
   - `configSchema` — a zod schema for whatever this connector needs in
     `connector_configs.config` (e.g. a Greenhouse board token, a SerpApi
     key reference). Never put a raw secret in the schema's *default* —
     `connector_configs.credentials_ref` (task 027) points at the secrets
     store; the config JSONB itself holds non-secret parameters only.
   - `fetchJobs(config, cursor)` — an `async function*` yielding
     `Result<RawJob, ConnectorError>`. Normalize the source API's shape into
     the canonical `RawJob` (title/company/location/remote/salary/
     postedAt/descriptionMd) inside this function — nothing connector-specific
     leaks past it. Errors (auth, config, rate limit, upstream) are **typed
     results**, never thrown.
   - `healthCheck(config)` — a cheap reachability/auth probe.
3. Add fixture-based tests: record a real (or representative) API response
   under `test/fixtures/*.json` and assert `fetchJobs` normalizes it
   correctly.
4. Run your connector through the shared contract test-kit:

   ```ts
   import { describeConnectorContract } from '../../sdk/contract-test-kit.js';

   describeConnectorContract('my-connector', () => ({
     connector: myConnector,
     validConfig: { ... },
     invalidConfig: { ... }, // must fail configSchema
   }));
   ```

   The kit asserts: metadata shape, config-schema rejects a bad config,
   `fetchJobs` never throws synchronously, every yielded job matches the
   canonical `RawJob` shape, `healthCheck` returns a typed `Result`, and two
   full fetch passes are idempotent (same set of `externalId`s).
5. Register the connector into `defaultRegistry` from the composition root
   (`apps/worker/src/main.ts`) — not from the connector package itself, so
   importing the package never has import-time side effects.
6. Default CI runs fixture tests only — **no live network calls**. A
   separate nightly workflow (mirroring the Ollama nightly pattern, task 014)
   exercises a real call per connector as a non-blocking canary.

## Package layout

```
src/
  sdk/            ConnectorPort re-export, contract-test-kit, registry
  class-a/        greenhouse/ lever/ ashby/ usajobs/ rss/ manual/
  class-b/        capture-ingest/ (task 030)
  class-c/        serpapi-google-jobs/ (task 031)
```
