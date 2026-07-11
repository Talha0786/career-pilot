# CareerPilot AI — Component & Sequence Diagrams

**Version:** 0.1 | **Status:** PROPOSED

## 1. Component Diagram

```mermaid
graph TB
    subgraph Clients
        WEB[Next.js Web App]
        MCPC[MCP Clients<br/>Claude / others]
        CLI[CLI]
    end

    subgraph API_Process[api]
        GW[Fastify HTTP + WS]
        AUTHM[Auth middleware]
        UC1[Use cases<br/>application layer]
    end

    subgraph MCP_Process[mcp-server]
        MCPS[MCP transport<br/>stdio / SSE]
        TOOLS[Tool handlers → same use cases]
    end

    subgraph Worker_Process[worker]
        SCHED[Scheduler<br/>cron → queues]
        ING[Ingestion handlers]
        MATCH[Matching handlers]
        GEN[Generation handlers]
        EXP[Export/render handlers]
    end

    subgraph Browser_Process[browser-runner]
        BRAPI[Task API gRPC/HTTP]
        PW[Playwright contexts]
        CDP[CDP screencast → WS]
    end

    subgraph Domain_Packages[shared packages]
        DOM[domain: profile, discovery,<br/>pipeline, intelligence]
        PORTS[ports: ConnectorPort, LlmPort,<br/>Repos, QueuePort, SecretsPort]
    end

    subgraph Infra
        PG[(PostgreSQL<br/>+ pgvector)]
        RD[(Redis<br/>BullMQ + cache)]
        FS[(Object store<br/>local FS / S3)]
        SEC[(Secrets store)]
    end

    subgraph External
        LLM[LLM providers<br/>Anthropic / OpenAI-compat / Ollama]
        SRC[Job sources<br/>ATS APIs, RSS, feeds]
        SITES[Company career sites]
    end

    WEB --> GW
    CLI --> GW
    MCPC --> MCPS
    GW --> AUTHM --> UC1
    MCPS --> TOOLS --> UC1
    UC1 --> DOM
    UC1 --> PORTS
    Worker_Process --> DOM
    Worker_Process --> PORTS
    PORTS --> PG
    PORTS --> RD
    PORTS --> FS
    PORTS --> SEC
    ING --> SRC
    MATCH --> LLM
    GEN --> LLM
    UC1 -->|enqueue| RD
    RD -->|consume| Worker_Process
    UC1 -->|ApplyTask cmds| BRAPI
    PW --> SITES
    CDP --> WEB
```

## 2. Sequence: Job Ingestion → Match → Notification

```mermaid
sequenceDiagram
    participant S as Scheduler (worker)
    participant Q as BullMQ
    participant W as Ingestion handler
    participant C as Connector adapter
    participant DB as Postgres
    participant M as Matching handler
    participant L as LLM provider
    participant U as User (web)

    S->>Q: enqueue ingest:{connectorId} (cron)
    Q->>W: job
    W->>DB: create IngestionRun(running)
    W->>C: fetchJobs(cursor)
    C-->>W: RawJob[] + nextCursor
    W->>W: normalize → JobPosting, dedup (url_hash, fuzzy)
    W->>DB: upsert postings, finish IngestionRun(ok, stats)
    W->>Q: emit JobIngested(ids) via outbox
    Q->>M: match:{profileId}
    M->>L: batch embed new JDs
    M->>DB: cosine top-K vs profile embedding
    M->>L: rubric scoring for top-N (budget-checked)
    M->>DB: insert match_scores
    M->>Q: NotifyMatches(above threshold)
    Q-->>U: WS push / email digest
```

## 3. Sequence: Assisted Apply (human-in-the-loop, exactly-once submit)

```mermaid
sequenceDiagram
    participant U as User (web)
    participant A as api
    participant DB as Postgres
    participant BR as browser-runner
    participant P as Playwright ctx
    participant T as Target career site

    U->>A: POST /applications/:id/apply-tasks
    A->>DB: ApplyTask(draft)
    A->>BR: start(taskId, targetUrl)
    BR->>P: new isolated context
    P->>T: navigate
    BR->>BR: detect form schema (heuristics + LLM field mapper)
    BR->>DB: state=mapping, steps appended
    BR->>P: fill fields, upload resume (no submit)
    BR->>DB: state=awaiting_review, screenshots stored
    BR-->>U: CDP screencast via WS
    U->>A: review diff of every field value
    U->>A: POST approve (fresh approval_token)
    A->>DB: set token (single-use, 5 min TTL)
    A->>BR: submit(taskId, token)
    BR->>DB: consume token atomically (fails if used/expired)
    BR->>P: click submit
    P->>T: submission
    BR->>DB: state=submitted, final screenshot, audit_log row
    A->>DB: Application → stage=applied, transition logged
```

## 4. Sequence: Tailored Resume Generation with Claim Verification

```mermaid
sequenceDiagram
    participant U as User
    participant A as api
    participant Q as BullMQ
    participant G as Generation handler
    participant L as LLM
    participant DB as Postgres

    U->>A: POST /jobs/:id/tailor (docKind=resume)
    A->>DB: budget precheck (ai_invocations + Redis counter)
    A->>Q: GenerationJob(contentHash idempotency key)
    Q->>G: job
    G->>DB: load profile facts + JD + base document
    G->>L: draft generation (facts-constrained prompt)
    G->>L: claim-verification pass (every claim ↦ profile fact id)
    alt unverifiable claim found
        G->>L: regenerate offending sections (max 2 retries)
        G->>DB: if still failing → job status=needs_human, flagged claims stored
    end
    G->>DB: DocumentVersion(source=generated) + ai_invocations rows
    G-->>U: WS notify → diff view vs base version
    U->>A: approve → render PDF/DOCX (export worker) 
```
