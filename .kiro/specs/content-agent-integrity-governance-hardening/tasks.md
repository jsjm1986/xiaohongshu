# Implementation Plan: Content Agent Integrity Governance Hardening

## Overview

This plan implements the approved design and requirements as ordered delivery batches
`Batch B → Batch C → Batch D → Batch E`, followed by full final validation that begins
with a Batch A recheck. Implementation language is **TypeScript** across the existing
`content-agent` npm-workspaces monorepo (`apps/api` NestJS, `apps/web` React + Vite,
`packages/agent-core` domain layer); the design's PASCAL-style interfaces are
language-neutral contracts realized in these existing modules.

Sequencing rules honored by this plan (Requirements 1.1, 1.7, 1.9, 1.10):

- **Batch A is an implemented baseline.** It is NOT reimplemented or reverted here. Its
  only obligation in this plan is the final recheck at the start of validation
  (Requirement 1.10). New application-code work starts at Batch B (Requirement 1.7).
- **Batches are strictly ordered.** Each successor batch stays pending until its
  predecessor's implementation obligations are complete (Requirement 1.9). The dependency
  graph reflects this: every Batch C task follows all Batch B tasks, and so on.
- **Final validation runs last** and starts by rechecking Batch A, then validates B→E in
  order, then the whole workspace (Requirements 25.9, 25.10).

Testing rules honored by this plan:

- All 17 design Correctness Properties map to explicit property-based test sub-tasks,
  annotated with the property number and the requirement clauses each preserves. Property
  tests use **at least 100 generated cases per property** (design Testing Strategy).
- Tests use synthetic environment maps, temporary SQLite databases, and fake provider
  transports only — never real secrets, production data, or external provider calls
  (Requirements 25.2, 25.3, 25.4, 25.5, 25.11).
- Test-related sub-tasks are marked optional with `*`. Core implementation sub-tasks are
  never optional.

## Tasks

- [ ] 1. Batch B — Secure provider gateway, credential/endpoint coupling, SSRF policy, production runtime, API/error and audit contracts (Requirements 9, 10, 11, 22.3, 22.4, 23, 24)
  - [ ] 1.1 Define the shared error envelope and stable error-code contract
    - Add an `ApiError` envelope type (`statusCode`, `code`, `message`, `retryable`, `correlationId`, redacted `details`) and a central stable error-code registry in the API shared layer (`apps/api/src`), with the normative code→HTTP-status mapping table wired into a NestJS exception filter.
    - Include the Batch B codes: `PROVIDER_ENDPOINT_INSECURE`, `PROVIDER_ENDPOINT_NOT_ALLOWED`, `PROVIDER_NETWORK_TARGET_BLOCKED`, `PROVIDER_REDIRECT_BLOCKED`, `PROVIDER_CREDENTIAL_ENDPOINT_MISMATCH`, `INSECURE_PRODUCTION_CONFIG`; reserve the full table for later batches.
    - Preserve the documented legacy Batch A 400 responses behind a transitional flag until the typed-status migration is regression-tested.
    - _Requirements: 23.8, 23.9, 23.10_

  - [ ] 1.2 Implement URL canonicalization and the deployment-owned endpoint allowlist
    - Add a `ProviderEndpointPolicy` module (`packages/agent-core/src/model.ts` shared client plus an API policy module) that canonicalizes scheme/host/effective-port origins, rejects userinfo and fragments, and matches an `EndpointAllowRule` set exactly (canonical origin incl. port).
    - Default rule authorizes only public HTTPS origins; allow a deployment-owned `Endpoint_Exception` naming an exact origin plus permitted CIDR/`Network_Class`. Allowlist creation/modification is reserved to deployment configuration (not workspace-editable).
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [ ] 1.3 Implement DNS resolution, address-class classification, and rebinding defense
    - Resolve all A/AAAA records and classify each address (`public`, `private`, `loopback`, `link_local`, carrier-grade NAT, `multicast`, `unspecified`, documentation/test, `metadata`); block any address not permitted by the effective rule.
    - Revalidate DNS at connection time or pin the approved address set for the request to resist rebinding.
    - _Requirements: 10.7, 10.8, 10.9_

  - [ ] 1.4 Implement redirect authorization
    - Deny redirects by default; where a deployment rule opts in named redirect origins, reauthorize every hop against an explicit canonical origin and strip the `Authorization` header on any cross-origin hop before re-evaluation.
    - _Requirements: 10.10, 10.11, 10.12, 10.13_

  - [ ] 1.5 Couple credential provenance to endpoint provenance and handle legacy URLs
    - Separate credential provenance (`platform_credential` vs `workspace_byok`) from endpoint provenance; pair the platform credential only with the deployment-managed origin (ignore/treat workspace `base_url` as inactive legacy data in platform mode) and pair a BYOK credential only with the same workspace's authorized endpoint.
    - Reject unauthorized pairings with `PROVIDER_CREDENTIAL_ENDPOINT_MISMATCH` and keep secret-bearing dispatch absent; re-evaluate a legacy BYOK endpoint against the current allowlist on first use; keep all secrets out of API responses.
    - _Requirements: 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 22.3, 22.4_

  - [ ] 1.6 Build the Secure Model Gateway and route every provider call site through it
    - Implement `SecureModelGateway.execute` enforcing authorized endpoint, request timeout, response-size bound, content-type handling, and structured-output parsing; redact secrets/prompts/knowledge/image bytes from logs.
    - Route generation, revision, project analysis, image analysis, and provider-validation through this single gateway (`packages/agent-core/src/model.ts`, `apps/api/src/generation.service.ts`, `intelligence.service.ts`, `settings.service.ts`) so no call site bypasses policy.
    - _Requirements: 9.1, 10.14, 10.15, 10.16_

  - [ ] 1.7 Enforce fail-closed production runtime configuration
    - At production startup validate bootstrap credentials, encryption/session secrets, secure-cookie policy, bounded trusted-proxy set, and a dedicated API bind-host setting; report `INSECURE_PRODUCTION_CONFIG` and stay not-ready when a required secret is missing/predictable.
    - Issue `Secure`+`HttpOnly` session cookies in production; replace generic `HOST` with a dedicated bind-host variable (container pins `0.0.0.0` with precedence over project `.env`; local default loopback); return only redacted config categories on failure.
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8_

  - [ ] 1.8 Wire Batch B audit, metrics, readiness, and provider/health endpoints
    - Emit typed structured audit events (`provider.endpoint_allowed|blocked`, `provider.redirect_blocked`) with correlation/rule/digest-prefix identifiers and no secrets; expose endpoint-policy-block and production-config metrics.
    - Add `POST /api/projects/:projectId/provider/validate` (routed through the gateway, no secret reveal) and extend `GET /health` with non-secret readiness (config, provider dependency degraded status) without sending credential-bearing probes.
    - _Requirements: 23.1, 23.2, 23.7, 24.1, 24.2, 24.3, 24.8_

  - [ ]* 1.9 Write property test for credential/endpoint coupling
    - **Property 9: Credential and endpoint provenance coupling**
    - **Validates: Requirements 9.2, 9.4, 9.5**

  - [ ]* 1.10 Write property test for SSRF fail-closed behavior
    - **Property 10: SSRF fail-closed behavior**
    - **Validates: Requirements 10.6, 10.7, 10.8, 10.13**

  - [ ]* 1.11 Write unit tests for gateway policy and production config
    - Cover URL canonicalization, allowlist matching, IP/network-class classification, redirect authorization, credential/endpoint coupling, redaction, and production-config fail-closed categories.
    - _Requirements: 9.5, 9.7, 10.5, 10.15, 11.2, 11.8_

  - [ ]* 1.12 Write integration tests for the gateway using fake transports and synthetic env
    - Exercise the gateway and `provider/validate` + `/health` against a `Fake_Provider_Transport` and synthetic environment maps; confirm no real provider call or real `.env` is used and no credential probe is sent on health.
    - _Requirements: 24.7, 25.2, 25.4_

- [ ] 2. Checkpoint — Batch B
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 3. Batch C — Explicit repository modes and online fail-closed behavior (Requirements 12, 13, 22.5)
  - [ ] 3.1 Define the repository abstraction and result/error types
    - Add a `ContentRepository` interface plus `Result<T, RepositoryError>` and typed retryability in `apps/web/src/lib`; establish `RepositoryMode = online | demo` as mutually exclusive per session.
    - _Requirements: 12.1_

  - [ ] 3.2 Implement OnlineRepository with fail-closed propagation
    - Return every API read/write error to the caller; never substitute fixtures, empty-success collections, `local-*` identifiers, or optimistic persisted-success; surface the stable `ONLINE_REPOSITORY_UNAVAILABLE` condition and preserve `Last_Known_Data` with an error state.
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.10_

  - [ ] 3.3 Implement DemoRepository as isolated session-only state
    - Assign `demo:`-prefixed identifiers, keep state in session-only memory by default, never auto-persist to browser-local storage or online persistence, drop state at session end, and state that server generation, automated-gate, persistence, review, and publication did not occur.
    - _Requirements: 13.5, 13.6, 13.7, 13.8, 13.9, 13.10, 13.11_

  - [ ] 3.4 Implement repository-mode selection, `/demo` gating, and persistent banner
    - Select `demo` only when deployment `Demo_Capability` is enabled and the user explicitly enters `/demo` (else return `DEMO_MODE_DISABLED`); show a persistent demo banner and mode label in every demo view; keep mode `online` on API outage (no automatic fallback).
    - _Requirements: 12.8, 13.1, 13.2, 13.3, 13.4_

  - [ ] 3.5 Reject demo-namespaced entities at the online API boundary
    - Add server-side validation so any `demo:` identifier reaching an online API is rejected with `DEMO_ENTITY_ONLINE_REJECTED`.
    - _Requirements: 12.9_

  - [ ] 3.6 Refactor web contexts/pages onto the repository abstraction and gate fixtures behind demo
    - Replace catch-based fixture/empty-success/`local-*`/swallowed-write substitution in auth/project contexts, dashboard, generation-result, and intelligent-flow loaders/mutations with the online/demo repositories; move `apps/web/src/lib/fixtures.ts` usage behind explicit demo mode only; on write failure keep input editable with typed retryability and no success notice.
    - _Requirements: 12.5, 12.6, 12.7, 22.5_

  - [ ]* 3.7 Write property test for demo/online isolation
    - **Property 11: Demo/online isolation**
    - **Validates: Requirements 12.7, 13.5**

  - [ ]* 3.8 Write unit tests for repository mode selection and error propagation
    - Cover mode mutual exclusion, `/demo` gating, online error propagation, and no-fallback-on-outage behavior.
    - _Requirements: 12.8, 13.1, 13.3, 13.11_

  - [ ]* 3.9 Write web integration tests for online-failure honesty
    - Assert that online read/write failures inject no fixtures, no `local-*` entities, no empty-success, and no false success notices.
    - _Requirements: 12.2, 12.4, 12.7_

- [ ] 4. Checkpoint — Batch C
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Batch D — Candidate digest, human review, and review-draft vs publish-ready export (Requirements 2.3, 2.9, 14, 15, 16, 22.1, 22.2, 22.12, 23.3–23.5, 24.1)
  - [ ] 5.1 Add the additive append-only candidate-review migration
    - Add a versioned, nested-safe SQLite migration in `apps/api/src/database.service.ts` for an append-only `candidate_review` table with unique review identity and an indexed `(candidate_id, content_digest, created_at)` lookup; enforce foreign keys and explicit delete behavior; do not update any historical row.
    - _Requirements: 14.6, 14.7, 21.1, 22.1_

  - [ ] 5.2 Implement the CandidateDigestService
    - Canonicalize `Canonical_Publish_Content` (all publish-visible title/body/tags/comment-reference/evidence/unknown/boundary/image-brief/artifact-status fields; sorted keys, preserved array order, normalized Unicode, explicit null/unknown; excludes review IDs, audit timestamps, display-only ordering, and the digest) and compute the SHA-256 digest server-side at both review and export time.
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.11_

  - [ ] 5.3 Implement the CandidateReviewService with eligibility and separation of duties
    - Append `approved | changes_requested | rejected` decisions bound to candidate id + digest + reviewer + note + exception metadata + timestamp; require `Candidate_Review_Permission`; require reviewer ≠ creator when ≥2 eligible reviewers exist; permit the `Single_User_Exception` only with explicit confirmation and non-empty reason when exactly one eligible reviewer exists; derive current/stale review state; keep prior rows immutable; derive legacy `unreviewed` with no synthetic approval.
    - _Requirements: 14.6, 14.8, 14.9, 14.10, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.10, 22.1_

  - [ ] 5.4 Separate automated-gate status from human review and relabel legacy quality fields
    - Keep `validation.valid` as an automated-gate-only field, derive automated-valid-without-approval candidates as not publish-ready, present each `Dynamic_Claim` as a review reason regardless of provenance, and relabel/deprecate `qualityStatus=passed` as an automated-gate compatibility field (keep provenance, external-verification, automated-gate, and review status as separate fields).
    - _Requirements: 2.3, 2.9, 15.1, 15.2, 15.9, 15.11_

  - [ ] 5.5 Implement ExportPolicy and export purpose separation
    - Add explicit `purpose` (default `review`); authorize `Review_Draft` only when the automated gate passes (else `AUTOMATED_VALIDATION_REQUIRED`), stamping the exact bilingual `Draft_Watermark` on every Markdown/DOCX/PDF page/section and mandatory top-level `publicationStatus:"draft"` + `watermark` + current review state in JSON; authorize clean `Publish_Ready_Export` only with a current digest-bound `approved` review and `Clean_Export_Permission` (else `CANDIDATE_REVIEW_REQUIRED` / `CANDIDATE_REVIEW_STALE`), including approval metadata and omitting the watermark; keep publish unavailable for `changes_requested`/`rejected` and for missing review support.
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 16.9, 16.10, 16.11, 16.12, 16.13, 22.2, 22.12_

  - [ ] 5.6 Wire the review/export API endpoints and audit
    - Implement `GET/POST /api/generations/:jobId/candidates/:candidateId/reviews` (server-computed current digest; `CANDIDATE_CONTENT_DIGEST_MISMATCH` on mismatch) and `GET /api/generations/:jobId/candidates/:candidateId/export?purpose=review|publish`; audit review decision, digest, reviewer, export purpose, export digest, and policy outcome without secrets.
    - _Requirements: 16.14, 23.3, 23.4, 23.5, 24.1_

  - [ ] 5.7 Build the candidate review and export-purpose web UI
    - Add review history/decision UI, single-user-exception confirmation, explicit export-purpose selection, and updated `apps/web/src/types.ts`, surfacing automated-gate vs human-review state distinctly.
    - _Requirements: 15.2, 15.11, 16.1, 16.7_

  - [ ]* 5.8 Write property test for review digest binding
    - **Property 12: Review digest binding**
    - **Validates: Requirements 14.8, 14.9**

  - [ ]* 5.9 Write property test for the export boundary
    - **Property 13: Export boundary**
    - **Validates: Requirements 16.4, 16.8**

  - [ ]* 5.10 Write unit tests for digest, review-state, and export matrix
    - Cover canonical-digest stability and sensitivity to every publish-visible field, review-state derivation, and the review/publish export-policy matrix.
    - _Requirements: 14.3, 14.8, 15.4, 16.10, 16.11_

  - [ ]* 5.11 Write integration tests for review/export across formats and states
    - Exercise API review + export for Markdown/DOCX/PDF/JSON across `unreviewed`, `approved`, `stale_approval`, `changes_requested`, and `rejected` states.
    - _Requirements: 16.4, 16.5, 16.6, 16.12, 16.13_

- [ ] 6. Checkpoint — Batch D
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Batch E — Durable leased work, proven-safe recovery, idempotency, quota ledger, additive migration (Requirements 17, 18, 19, 20, 21, 22.6–22.8, 23.6, 24.4, 24.9)
  - [ ] 7.1 Add the additive durable-work and quota migration
    - Add versioned, nested-safe SQLite migrations for `work_item`, `work_lease`, `work_checkpoint`, `quota_reservation`, `quota_ledger`, and additive integrity `runtime_snapshot` data with: unique work idempotency key per work-type/aggregate scope, one current lease per work item, unique checkpoint per work/attempt, unique quota-ledger idempotency key, foreign keys with explicit delete behavior, ISO-8601 timestamps, WAL mode with bounded busy timeout, covering indexes for claim order/lease expiry/reconciliation, and no destructive down-migration.
    - _Requirements: 21.1, 21.2, 21.6, 21.7, 21.8, 21.9, 21.10, 21.12, 22.10_

  - [ ] 7.2 Implement WorkCoordinator enqueue with idempotency binding
    - Persist a `Work_Item` before acknowledging acceptance; bind the idempotency key to work type + aggregate + payload digest; return the existing item on same-key+same-payload enqueue; reject same-key+different-payload with `IDEMPOTENCY_CONFLICT`.
    - _Requirements: 17.1, 19.1, 19.2, 19.3_

  - [ ] 7.3 Implement lease claim, heartbeat, and lease-token verification
    - Acquire exactly one lease via a conditional SQLite `Compare_And_Swap` transaction (60s duration); emit heartbeat every 20s and extend expiry on valid heartbeat; verify the current lease token on every work/checkpoint/result/coverage/quota/terminal mutation and reject stale tokens with `WORK_LEASE_CONFLICT`; keep competing claims unsuccessful while a lease is valid; store the token as a hash; keep SQLite write transactions closed during provider I/O.
    - _Requirements: 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10, 21.11_

  - [ ] 7.4 Implement durable dispatch checkpoints
    - Persist `intent_recorded`, `request_sent`, `response_received`, and `committed` checkpoints at their boundaries (with request/staged-response digests and provider request id) so recovery can reason about external-call state.
    - _Requirements: 17.11_

  - [ ] 7.5 Implement proven-safe recovery, restart handling, and legacy work classification
    - Cap automatic attempts at three; requeue only `not_started`/`intent_recorded`-with-no-send-evidence within the attempt limit; recover `response_received` locally from a staged response without a new dispatch; classify `request_sent`/`outcome_unknown`/insufficient-evidence as `interrupted_review_required` with no automatic replay; apply checkpoint-based recovery on restart (not blanket-fail); support pre-dispatch cancellation; classify legacy queued/running rows accordingly and preserve completed/failed rows.
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.10, 18.11, 22.6, 22.7, 22.8_

  - [ ] 7.6 Implement idempotent result, coverage, and completion commits
    - Make result/coverage/completion commits idempotent by work id + operation key + result digest (same digest replays the prior state with no duplicate candidates/coverage/terminal events; different digest rejects with `IDEMPOTENCY_CONFLICT`); recovered staged responses reuse the original result operation key.
    - _Requirements: 19.4, 19.5, 19.6, 19.7, 19.8_

  - [ ] 7.7 Implement the QuotaLedger in provider-dispatch units
    - Reserve projected dispatch units atomically before promising dispatch capacity (`QUOTA_RESERVATION_FAILED` when exceeding available); keep queued-only work unsettled; bind each authorized dispatch to a unique dispatch idempotency key; settle known outcomes exactly once; release unused units once; hold unknown outcomes in `outcome_unknown` (unavailable for reuse) and append one idempotent reconciliation entry; preserve `available + reserved + settled = Accounting_Total`; retain optional provider token/cost fields without changing enforcement.
    - _Requirements: 20.1, 20.2, 20.3, 20.5, 20.6, 20.7, 20.8, 20.9, 20.10, 20.11, 20.12, 20.13_

  - [ ] 7.8 Wire work coordination, quota, retry, and queue health into services
    - Route generation, project-analysis, and image-analysis acceptance through the coordinator (enqueue → reserve → dispatch via the Batch B gateway → checkpoint → settle/commit); keep provider dispatch absent when reservation fails; add `POST /api/work-items/:id/retry` (permission-gated, linked attempt, new provider idempotency key unless proven safe) exposing `WORK_OUTCOME_UNCERTAIN`/`QUOTA_RECONCILIATION_REQUIRED`; expose queue/quota health (queued/leased/running/interrupted, oldest age, lease expiry, reconciliation backlog) and metrics.
    - _Requirements: 17.1, 18.7, 18.8, 18.9, 20.4, 20.14, 23.6, 24.4, 24.9_

  - [ ]* 7.9 Write property test for exclusive lease ownership
    - **Property 14: Exclusive lease ownership**
    - **Validates: Requirements 17.2, 17.8**

  - [ ]* 7.10 Write property test for no blind retry after uncertain dispatch
    - **Property 15: No blind retry after uncertain dispatch**
    - **Validates: Requirements 18.5, 18.6**

  - [ ]* 7.11 Write property test for idempotent result commit
    - **Property 16: Idempotent result commit**
    - **Validates: Requirements 19.4, 19.6, 19.7**

  - [ ]* 7.12 Write property test for quota conservation
    - **Property 17: Quota conservation**
    - **Validates: Requirements 20.7, 20.12**

  - [ ]* 7.13 Write migration tests on temporary databases
    - Migrate representative prior schema versions on temporary SQLite databases; assert additive, transactional rollback-on-failure, preserved history, and enforced unique/foreign-key/index constraints.
    - _Requirements: 21.2, 21.3, 21.4, 21.5, 25.3_

  - [ ]* 7.14 Write concurrency and restart integration tests
    - Use two instances contending for the same work and quota, and restart at each durable checkpoint, with a `Fake_Provider_Transport` and temporary databases (no real provider/network).
    - _Requirements: 25.5_

- [ ] 8. Checkpoint — Batch E
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Final validation — Batch A recheck, ordered B→E validation, and full workspace verification (Requirements 1, 2, 4, 5, 8, 25)
  - [ ] 9.1 Recheck the Batch A baseline
    - Re-run the existing knowledge/release/formula/catalog/nested-transaction targeted tests and run the API typecheck; confirm the preserved invariants hold (latest-knowledge selection and stale/invalid rejection, active-release/runtime-contract revalidation, formula-activation release invalidation, F10 `r14` catalog consistency, savepoint transactions) without reimplementing or reverting Batch A.
    - _Requirements: 1.2, 1.8, 1.10, 3.4, 3.5, 4.10, 5.4, 6.4, 6.9, 6.10, 7.6, 8.9, 25.9_

  - [ ]* 9.2 Write property test for latest logical knowledge selection
    - **Property 1: Latest logical knowledge wins**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**

  - [ ]* 9.3 Write property test for runtime contract consistency
    - **Property 2: Runtime contract consistency**
    - **Validates: Requirements 6.4, 6.5, 8.2**

  - [ ]* 9.4 Write property test for formula-activation release invalidation
    - **Property 3: Formula activation invalidates incompatible release**
    - **Validates: Requirements 6.6**

  - [ ]* 9.5 Write property test for research isolation
    - **Property 4: Research isolation**
    - **Validates: Requirements 5.1, 5.4**

  - [ ]* 9.6 Write property test for intelligence dependency freshness
    - **Property 5: Intelligence dependency freshness**
    - **Validates: Requirements 4.6, 4.9, 4.10**

  - [ ]* 9.7 Write property test for the frozen three-candidate run
    - **Property 6: Frozen three-candidate run**
    - **Validates: Requirements 8.5, 8.6, 8.7, 8.8**

  - [ ]* 9.8 Write property test for unknown and artifact-state preservation
    - **Property 7: Unknown and artifact-state preservation**
    - **Validates: Requirements 2.4, 2.5, 2.6, 2.7**

  - [ ] 9.9 Run the ordered per-batch validation suites
    - Execute, in order, the Batch B security tests, Batch C repository/fallback tests, Batch D review/export tests, and Batch E migration/concurrency/restart/quota tests in single-run mode, using synthetic env maps, temporary databases, and fake transports only.
    - _Requirements: 25.8, 25.9, 25.11_

  - [ ] 9.10 Run the full workspace suite, typecheck, and production build
    - Run complete `agent-core`, web, and API tests in single-run mode, then the workspace typecheck (`npm run typecheck`), then the production build (`npm run build`).
    - _Requirements: 25.8, 25.9_

  - [ ] 9.11 Review repository status without mutation
    - Run a non-mutating `git status` review and confirm changes are limited to intended `content-agent` paths; do not stage, commit, restore, or rewrite unrelated parent-repository state; confirm Batch A is attributed to the pre-specification baseline.
    - _Requirements: 1.1, 1.11, 25.6, 25.10_

- [ ] 10. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation sub-tasks are never optional.
- Batch A is an already-implemented baseline. This plan neither reimplements nor reverts it; task 9.1 is its only recheck obligation, and tasks 9.2–9.8 add regression property tests that lock in the Batch A invariants (Properties 1–7) without changing Batch A behavior.
- New application-code work begins at Batch B (task 1); batches are delivered strictly in order B → C → D → E, and final validation (task 9) runs last starting with the Batch A recheck.
- Every property test uses at least 100 generated cases per property and references the design property number plus the requirement clauses it preserves.
- All validation uses synthetic environment maps, temporary SQLite databases, and fake provider transports; no real secrets, production data, or external provider calls are used, and dependency additions are exact-pinned and limited to implementation/regression-test needs.
- Property→requirement→batch coverage: P9,P10 (Batch B); P11 (Batch C); P12,P13 (Batch D); P14–P17 (Batch E); P1–P7 (Batch A recheck). Property 8 (automated validation is not publication approval) is enforced by tasks 5.4/5.5 and exercised by the export-boundary tests (5.9/5.11).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.5", "1.7"] },
    { "id": 2, "tasks": ["1.4"] },
    { "id": 3, "tasks": ["1.6"] },
    { "id": 4, "tasks": ["1.8", "1.9", "1.10", "1.11"] },
    { "id": 5, "tasks": ["1.12"] },
    { "id": 6, "tasks": ["3.1"] },
    { "id": 7, "tasks": ["3.2", "3.3"] },
    { "id": 8, "tasks": ["3.4", "3.5"] },
    { "id": 9, "tasks": ["3.6"] },
    { "id": 10, "tasks": ["3.7", "3.8", "3.9"] },
    { "id": 11, "tasks": ["5.1", "5.2"] },
    { "id": 12, "tasks": ["5.3", "5.4"] },
    { "id": 13, "tasks": ["5.5"] },
    { "id": 14, "tasks": ["5.6"] },
    { "id": 15, "tasks": ["5.7"] },
    { "id": 16, "tasks": ["5.8", "5.9", "5.10", "5.11"] },
    { "id": 17, "tasks": ["7.1"] },
    { "id": 18, "tasks": ["7.2", "7.7"] },
    { "id": 19, "tasks": ["7.3"] },
    { "id": 20, "tasks": ["7.4"] },
    { "id": 21, "tasks": ["7.5"] },
    { "id": 22, "tasks": ["7.6"] },
    { "id": 23, "tasks": ["7.8"] },
    { "id": 24, "tasks": ["7.9", "7.10", "7.11", "7.12", "7.13", "7.14"] },
    { "id": 25, "tasks": ["9.1", "9.2", "9.3", "9.4", "9.5", "9.6", "9.7", "9.8"] },
    { "id": 26, "tasks": ["9.9"] },
    { "id": 27, "tasks": ["9.10"] },
    { "id": 28, "tasks": ["9.11"] }
  ]
}
```
