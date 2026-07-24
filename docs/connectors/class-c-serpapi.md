# Class C connector: Google Jobs via SerpApi

**Compliance class:** C — BYO-key licensed provider (ADR-004).

## What this is

[SerpApi](https://serpapi.com) is a paid, licensed third-party service that
scrapes Google's search results (including Google Jobs, which itself
aggregates postings from LinkedIn, Indeed, and many other boards) and
returns structured JSON. CareerPilot ships an **adapter** to SerpApi's
Google Jobs API — it does not scrape anything itself, and it does not
resell or bundle SerpApi's service.

## Who pays, and who's liable for what

- **You supply your own SerpApi API key.** CareerPilot does not provide one,
  does not subsidize usage, and never sees or stores your key in plaintext
  (see [Setup](#setup) below).
- **SerpApi's pricing** (as of this writing; check
  [serpapi.com/pricing](https://serpapi.com/pricing) for current numbers)
  starts with a free tier (100 searches/month) and scales with paid plans
  for higher volume. Each connector run against this adapter consumes
  SerpApi search credits under your plan.
- **Compliance and scraping liability sit with SerpApi, under your contract
  with them** — not with CareerPilot. This is the entire point of Class C
  in ADR-004: CareerPilot's code never touches Google or LinkedIn/Indeed
  directly for this path. Read SerpApi's own
  [terms of service](https://serpapi.com/legal) before relying on this for
  anything you care about legally.
- If SerpApi changes its API shape, rate limits, or pricing, that's a
  SerpApi-side change this adapter may need to be updated for — same as any
  third-party API integration.

## Setup

1. Create a SerpApi account and get an API key from
   [serpapi.com/manage-api-key](https://serpapi.com/manage-api-key).
2. Store the key using CareerPilot's `SecretsPort` (env var or the
   encrypted file store — see the security model, §4), NOT in the
   `connector_configs.config` JSONB column directly.
3. When creating the connector config, set `credentials_ref` to point at
   where you stored it (e.g. an env var name like `SERPAPI_API_KEY`). The
   `config` JSONB holds only non-secret parameters:
   ```json
   { "query": "senior backend engineer", "location": "United States" }
   ```
4. The composition root resolves `credentials_ref` to the actual key value
   and merges it into the config object handed to the connector at call
   time — the raw key is never written back into the database.

## What you get

Search-query-driven job discovery (you configure a `query`, optionally a
`location`) rather than a specific company board — this is fundamentally
different from Class A connectors (which target one company's postings) and
closer to "search the aggregated job market for X." Postings from
LinkedIn/Indeed/etc. that Google Jobs has indexed show up here, giving you a
secondary (paid) path to that coverage without CareerPilot itself touching
those platforms — the primary, free path being Class B capture
(`docs/adr/ADR-004-connector-plugin-architecture.md`).

## Known limitations

- **No absolute posted date.** SerpApi's Google Jobs API only returns a
  relative string ("3 days ago", "Just posted") — the adapter converts what
  it can parse into an approximate `Date` and returns `null` for anything
  it can't confidently parse. Never fabricates a date.
- **Salary is free text.** `detected_extensions.salary` (e.g. "$150,000–
  $190,000 a year") is best-effort regex-parsed; unparseable text yields
  `salary: null` rather than a wrong number.
- **Coverage varies** by what Google Jobs has indexed for a given query —
  this is not exhaustive, and results may differ from what you'd see
  searching directly.
