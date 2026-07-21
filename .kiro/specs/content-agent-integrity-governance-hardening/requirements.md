# Requirements Document: Content Agent Integrity Governance Hardening

## Document Status

- **Feature**: `content-agent-integrity-governance-hardening`
- **Workflow**: Design-first
- **Source of truth**: User-approved `design.md`, including all six approved implementation-policy defaults
- **Requirements state**: Derived requirements, pending user review
- **Implementation state**: No implementation is authorized or performed by this requirements phase
- **Batch A status**: **Implemented before this spec; final recheck required**
- **Repository boundary for spec creation**: `.kiro/specs/content-agent-integrity-governance-hardening/`

## Introduction

These requirements define integrity, governance, outbound-provider security, explicit repository modes, digest-bound human publication review, durable work execution, and quota accounting for Content Agent. The requirements preserve the existing intelligence-to-generation lifecycle while making approval order, dependency freshness, runtime contracts, persistence outcomes, credential routing, exports, and retries explicit and fail-closed.

The implementation program is ordered Batch A → Batch B → Batch C → Batch D → Batch E, followed by complete validation. Batch A is an existing implementation baseline rather than work newly completed under this specification. Batch A must receive a final recheck; B–E remain implementation work. Automated validation establishes only automated gate results. Human publication approval remains a distinct, content-digest-bound decision.

## Glossary

- **Accounting_Total**: The configured quota capacity partitioned into available, reserved, and settled Dispatch_Units for one accounting period.
- **Candidate_Review_Permission**: The dedicated Workspace permission authorizing a Principal to submit Candidate_Review decisions.
- **CIDR**: Classless Inter-Domain Routing notation used to identify an explicitly bounded network-address range.
- **Clean_Export_Permission**: The dedicated permission authorizing a Principal to request Publish_Ready_Export output.
- **Compare_And_Swap**: An atomic conditional database update that succeeds only when the persisted state still matches the expected state.
- **Deployment_Operator**: An operator authorized to modify Deployment_Configuration but not Workspace-owned content.
- **DNS_Address_Record**: An A record containing an IPv4 address or an AAAA record containing an IPv6 address returned for a hostname.
- **Export_Service**: The server component that authorizes and renders Review_Draft and Publish_Ready_Export artifacts.
- **F10**: The runtime formula catalog entry whose approved equation is `Cref=Rollout(ρC|Role×Scene×Register×Topology×Gap)`.
- **Fake_Provider_Transport**: A controlled local resolver and transport test double that performs no request to an External_Provider.
- **HTTP/HTTPS**: Hypertext Transfer Protocol and its encrypted form used for provider requests.
- **ISO-8601**: The timestamp text format already used by the repository for persisted dates and times.
- **JSON**: JavaScript Object Notation used for canonical content and machine-readable exports.
- **Latest_Knowledge**: The deterministic current non-deleted Knowledge_Version selected for every Logical_Filename.
- **SQLite**: The embedded relational database used by Content_Agent persistence and durable work coordination.
- **SSRF**: Server-side request forgery, in which attacker-controlled network input causes a server to contact an unauthorized destination.
- **UI**: The Content_Agent browser user interface.
- **WAL**: SQLite write-ahead logging mode used to support bounded concurrent reads and writes.
- **Worker**: A lease-owning execution process or embedded execution loop that handles one Work_Attempt.
- **Active_Formula**: The single Formula version currently activated for a Project.
- **Active_Release**: The approved Release currently activated for formal runtime use.
- **API_Error**: A redacted error envelope containing `statusCode`, `code`, `message`, `retryable`, `correlationId`, and redacted `details`.
- **Artifact_State**: An explicit lifecycle state such as planned, briefed, observed, drafted, produced, captured, or published.
- **Audit_Service**: The Content_Agent component that records security and governance events without sensitive payloads.
- **Automated_Gate**: Automated fact, evidence, closure, structure, and policy checks represented by `validation.valid`; an Automated_Gate is not human publication approval.
- **Batch_A**: Existing knowledge, release/formula/runtime-contract, evidence-catalog, and nested-transaction hardening whose status is “Implemented before this spec; final recheck required.”
- **Batch_B**: Provider endpoint, credential-coupling, SSRF, authentication, and production-runtime security work.
- **Batch_C**: Explicit demo repository and online fail-closed behavior work.
- **Batch_D**: Candidate digest, human review, and review-draft versus publish-ready export work.
- **Batch_E**: Durable leased work execution, recovery, idempotency, and quota-ledger work.
- **Blueprint_Module**: One of exactly seven intelligence modules: `knowledge_map`, `domain_model`, `audience_model`, `scenario_model`, `role_model`, `claim_policy`, or `surface_language`.
- **BYOK_Credential**: An encrypted provider credential owned by one Workspace and supplied under bring-your-own-key mode.
- **Candidate**: One generated content package belonging to a Formal_Generation job.
- **Candidate_Digest_Service**: The server component that canonicalizes publish-visible Candidate content and computes its Canonical_Content_Digest.
- **Candidate_Review**: An append-only human decision of `approved`, `changes_requested`, or `rejected`, bound to one Candidate and Canonical_Content_Digest.
- **Candidate_Review_Service**: The server component that enforces reviewer eligibility, separation of duties, review history, and Current_Review derivation.
- **Canonical_Content_Digest**: A SHA-256 digest of Canonical_Publish_Content.
- **Canonical_Origin**: A normalized URL origin consisting of scheme, canonical host, and effective port.
- **Canonical_Publish_Content**: Stable JSON containing every publish-visible Candidate field, with sorted object keys, preserved array order, normalized Unicode, and explicit null or Unknown_Value representations.
- **Calibration_Proposal**: A proposed runtime-parameter change derived from research and requiring explicit approval plus binding to an approved Active_Release.
- **Content_Agent**: The complete API, web application, core packages, persistence, and Worker behavior governed by this specification.
- **Content_Agent_API**: The server-side HTTP interface of Content_Agent.
- **Creator**: The Principal recorded as creating the Candidate or initiating the generation that produced the Candidate.
- **Current_Approval**: The latest non-stale explicit approval matching the current content revision or digest of the governed record.
- **Current_Review**: The latest Candidate_Review whose Canonical_Content_Digest equals the Candidate’s current Canonical_Content_Digest.
- **Demo_Capability**: Deployment-owned configuration that permits the `/demo` entry route to operate.
- **Demo_Entity**: An entity with a `demo:` identifier that exists only in Demo_Repository state.
- **Demo_Repository**: The explicitly selected session-only repository used by `/demo`; it does not claim online persistence or server execution.
- **Dependency_Snapshot**: The immutable set of revision IDs, content digests, approval times, and dependency links used to prove intelligence freshness.
- **Deployment_Configuration**: Operator-controlled settings that Workspace users cannot modify, including platform origin, endpoint allowlist, internal-network exceptions, redirect rules, secrets, proxy policy, bind host, and Demo_Capability.
- **Deployment_Managed_Origin**: The Canonical_Origin controlled by a Deployment_Operator and paired with the Platform_Credential.
- **Diagnostic**: A check result that describes observed structure or policy conformance without establishing quality, effectiveness, conversion, causality, recommendation probability, or medical suitability.
- **Dispatch_Checkpoint**: A durable Work_Attempt state of `not_started`, `intent_recorded`, `request_sent`, `response_received`, `committed`, or `outcome_unknown`.
- **Dispatch_Unit**: The initial quota unit, equal to one provider HTTP request dispatched by Content_Agent.
- **Draft_Watermark**: The exact literal `DRAFT — NOT APPROVED FOR PUBLICATION / 审阅稿，不得发布`.
- **Dynamic_Claim**: A medical, price, campaign, activity, credential, guarantee, suitability, outcome, or comparable claim whose truth can vary by time, person, or external condition.
- **Eligible_Reviewer**: An active Workspace member holding the Candidate_Review_Permission.
- **Endpoint_Allowlist**: Deployment-owned rules authorizing provider Canonical_Origins and any narrowly scoped network-class, CIDR, or redirect exceptions.
- **Endpoint_Exception**: A Deployment_Configuration rule naming an exact Canonical_Origin plus explicitly permitted CIDR or Network_Class for an internal gateway.
- **Evidence_Catalog**: The versioned source and claim catalog whose raw digest and runtime semantic definitions are validated independently.
- **External_Provider**: A real third-party model endpoint outside the controlled fake transports used by tests.
- **Externally_Verified**: A provenance state supported by independent external verification; `user_supplied` and `source` alone are not Externally_Verified.
- **Formal_Generation**: A production generation request that requires an Active_Release, passes integrity preflight, freezes one Runtime_Snapshot, and targets exactly three Candidates.
- **Formula**: A versioned runtime generation formula with a stable identifier, equation, semantic fingerprint, and digest.
- **Gap_Record**: A versioned gap derived after the seven Blueprint_Modules receive Current_Approval.
- **Hardening_Program**: The ordered A→E implementation and validation effort defined by this specification.
- **Heartbeat**: A lease-owner update emitted every 20 seconds to extend a valid Lease.
- **Idempotency_Key**: A unique operation key bound to a payload digest so replay returns the prior result and conflicting payload reuse is rejected.
- **Implementation_Workflow**: Future coding-agent work that implements approved tasks; it is distinct from the current Spec_Workflow.
- **Intelligence_Governance**: The component enforcing intelligence, Blueprint_Module, Gap_Record, Strategy_Record, and Opportunity_Record sequencing and freshness.
- **Intelligence_Record**: A versioned project-intelligence artifact that must receive Current_Approval before Blueprint_Module approval.
- **Knowledge_Resolver**: The component that selects current Project_Knowledge and rejects stale or invalid selected versions.
- **Knowledge_Version**: One immutable version of a logical knowledge file.
- **Last_Known_Data**: Previously successful Online_Repository data displayed with an explicit stale/error state after a later read failure.
- **Lease**: Exclusive, durable Work_Item ownership lasting 60 seconds unless renewed by Heartbeat.
- **Lease_Token**: An unguessable ownership credential checked for each Work_Item mutation and stored as a hash where feasible.
- **Logical_Filename**: The stable identity grouping all Knowledge_Versions of one project file.
- **Migration_Service**: The component applying additive, versioned, transactional SQLite schema changes.
- **Network_Class**: An address category such as public, private, loopback, link-local, carrier-grade NAT, multicast, unspecified, documentation/test, or metadata.
- **Online_Repository**: The repository that communicates with Content_Agent_API and propagates read or write failures without demo substitution.
- **Opportunity_Record**: A versioned opportunity requiring independent Current_Approval after approved gaps and strategy.
- **Parent_Repository**: Repository state outside the intended `content-agent` implementation paths, including pre-existing untracked, modified, staged, or ignored files.
- **Platform_Credential**: A deployment-level model-provider credential that may be sent only to the Deployment_Managed_Origin.
- **Principal**: An authenticated actor with a stable identifier and permission set.
- **Project**: A Content_Agent content workspace unit containing knowledge, intelligence, formula, release, generation, image, and review records.
- **Project_Knowledge**: Factual input constrained by its declared provenance, scope, Logical_Filename, version, and evidence state.
- **Provider_Usage_Metadata**: Optional provider-reported input-token, output-token, monetary-cost, and currency fields retained for future accounting models.
- **Proven_Safe_Replay**: Automatic retry supported by durable evidence that no external request was sent, or local completion from a durably staged response without a new provider request.
- **Provenance**: The declared origin and scope of a fact or artifact, including `user_supplied`, `source`, or independently verified evidence.
- **Publish_Ready_Export**: A clean export permitted only for an Automated_Gate-passing Candidate with a Current_Review of `approved` and matching Canonical_Content_Digest.
- **Quota_Ledger**: The durable, idempotent record of quota reservations, dispatches, settlements, releases, unknown outcomes, and reconciliations.
- **Quota_Reservation**: Dispatch_Units atomically held for a Work_Item before dispatch capacity is promised.
- **Readiness**: The service state indicating migrations, SQLite, catalog consistency, and required local runtime controls are usable.
- **Real_Environment_File**: An actual project or operator `.env` file rather than a synthetic environment map created by a test.
- **Release**: A versioned, reviewable manifest binding a Formula and all runtime-contract versions and digests.
- **Repository_Mode**: The mutually exclusive `online` or `demo` repository selected for one browser session.
- **Research_Governance**: The component isolating research from prompt construction and controlling Calibration_Proposal approval and release binding.
- **Research_Record**: A claim, source, dataset, experiment, result, or proposal created by research workflows.
- **Review_Draft**: An export for review that passes the Automated_Gate but lacks publish authorization and therefore carries the Draft_Watermark.
- **Runtime_Contract**: The active Formula ID/digest, execution-policy version/digest, prompt version/digest, parameter-policy version/digest, and Evidence_Catalog version/digest.
- **Runtime_Contract_Guard**: The component validating Release and Runtime_Contract agreement at review, activation, acceptance, and execution.
- **Runtime_Snapshot**: The immutable, persisted inputs and contract bindings shared by all Candidates in one Formal_Generation.
- **Secret_Bearing_Request**: An outbound request containing an authorization credential or other provider secret.
- **Secure_Model_Gateway**: The only component authorized to dispatch generation, revision, project-analysis, image-analysis, or provider-validation model requests.
- **SHA-256**: The 256-bit cryptographic digest algorithm used for immutable content and provenance fingerprints.
- **Single_User_Exception**: An explicit, reasoned, audited Candidate_Review exception available only when exactly one Eligible_Reviewer exists.
- **Spec_Directory**: `.kiro/specs/content-agent-integrity-governance-hardening/` within the `content-agent` repository.
- **Spec_Workflow**: The design-first creation of `.config.kiro`, `design.md`, `requirements.md`, and later `tasks.md` without application implementation.
- **Strategy_Record**: A versioned strategy selected after Blueprint_Module and Gap_Record approvals.
- **Uncertain_Dispatch**: A Work_Attempt for which durable evidence cannot prove that an external request was absent or safely completed locally.
- **Unknown_Value**: An explicit unknown, absent, or not-evaluated value that must not be replaced by a fact, zero, score, confidence, default, or approval.
- **Validation_Harness**: Automated tests, type checks, builds, migration checks, and status checks used for final validation.
- **Work_Attempt**: One linked execution attempt for a Work_Item, capped at three automatic attempts when each replay is proven safe.
- **Work_Coordinator**: The SQLite-backed component that enqueues, leases, checkpoints, recovers, and completes work.
- **Work_Item**: Durable generation, project-analysis, or image-analysis work.
- **Workspace**: The tenant boundary owning users, Projects, BYOK_Credentials, permissions, and quota.

## Requirements

### Requirement 1: Preserve delivery order and baseline truth

**User Story:** As a maintainer, I want an honest ordered delivery ledger, so that existing work is not misrepresented and dependent hardening is implemented safely.

#### Acceptance Criteria

1. THE Hardening_Program SHALL preserve the dependency order `Batch_A → Batch_B → Batch_C → Batch_D → Batch_E`.
2. THE Hardening_Program SHALL record the Batch_A status exactly as `Implemented before this spec; final recheck required`.
3. THE Hardening_Program SHALL record the Batch_B status at requirements derivation as `Design/read only; not implemented`.
4. THE Hardening_Program SHALL record the Batch_C status at requirements derivation as `Not started`.
5. THE Hardening_Program SHALL record the Batch_D status at requirements derivation as `Not started`.
6. THE Hardening_Program SHALL record the Batch_E status at requirements derivation as `Not started`.
7. WHEN implementation under this specification begins, THE Implementation_Workflow SHALL start new application-code work with Batch_B.
8. THE Hardening_Program SHALL treat the pre-specification Batch_A implementation as the satisfied implementation prerequisite for Batch_B while retaining the final-recheck obligation.
9. WHILE implementation obligations of Batch_B, Batch_C, or Batch_D remain incomplete, THE Implementation_Workflow SHALL keep the corresponding dependent successor batch in a pending state.
10. WHEN final validation begins, THE Validation_Harness SHALL recheck Batch_A before executing Batch_B through Batch_E validation.
11. THE Hardening_Program SHALL attribute Batch_A implementation to the pre-specification baseline rather than to work performed under this specification.

### Requirement 2: Preserve provenance, unknowns, and artifact lifecycle

**User Story:** As a reviewer, I want factual and lifecycle boundaries preserved, so that generated content does not turn uncertain or planned information into verified outcomes.

#### Acceptance Criteria

1. THE Content_Agent SHALL constrain each Project_Knowledge fact to the declared Provenance and scope.
2. WHEN Project_Knowledge has `user_supplied` or `source` Provenance without independent evidence, THE Content_Agent SHALL label the Project_Knowledge as not Externally_Verified.
3. WHEN a Candidate contains a Dynamic_Claim, THE Content_Agent SHALL retain the Dynamic_Claim as a human publication-review reason.
4. THE Content_Agent SHALL preserve every Unknown_Value as an explicit unknown or not-evaluated state through snapshots, diagnostics, Candidates, reviews, and exports.
5. WHEN an input value is missing, THE Content_Agent SHALL represent the input value as Unknown_Value rather than as zero, a default fact, confidence, score, or approval.
6. WHEN an artifact is planned, briefed, observed, or intended, THE Content_Agent SHALL preserve the corresponding Artifact_State until evidence records a valid later lifecycle transition.
7. WHEN an image record contains an observation, THE Content_Agent SHALL label the record as an observation rather than as a produced final image.
8. WHEN Content_Agent displays a Diagnostic, THE Content_Agent SHALL identify the result as an automated check rather than as proof of quality, effect, conversion, causality, recommendation probability, or medical suitability.
9. THE Content_Agent SHALL keep factual provenance, external verification, Automated_Gate status, and Candidate_Review status as separate fields.

### Requirement 3: Resolve current project knowledge deterministically

**User Story:** As a content operator, I want formal work to use only current logical knowledge versions, so that stale facts cannot silently enter intelligence or generation.

#### Acceptance Criteria

1. THE Knowledge_Resolver SHALL select exactly one non-deleted Knowledge_Version for each Logical_Filename.
2. THE Knowledge_Resolver SHALL rank Knowledge_Versions by version, creation timestamp, and stable identifier in deterministic descending precedence.
3. WHEN Content_Agent lists active Project_Knowledge, THE Knowledge_Resolver SHALL return only the current Knowledge_Version for each Logical_Filename.
4. WHEN a selected Knowledge_Version is historical for its Logical_Filename, THE Content_Agent_API SHALL reject the selection with `KNOWLEDGE_VERSION_STALE`.
5. WHEN a selected Knowledge_Version is missing, deleted, or owned by another Project, THE Content_Agent_API SHALL reject the selection with `KNOWLEDGE_SELECTION_INVALID`.
6. WHEN knowledge selection is rejected, THE Content_Agent SHALL keep Formal_Generation and provider dispatch absent.
7. WHEN knowledge selection is rejected, THE Quota_Ledger SHALL keep quota totals unchanged.
8. THE Content_Agent SHALL retain historical Knowledge_Versions for audit access.
9. WHEN Runtime_Snapshot captures Project_Knowledge, THE Content_Agent SHALL record Logical_Filename, selected identifier, version, SHA-256 digest, evidence status, scope, and Provenance.

### Requirement 4: Enforce intelligence-to-opportunity approval sequencing

**User Story:** As a governance reviewer, I want approvals to follow the intelligence dependency chain, so that formal generation uses independently reviewed current reasoning.

#### Acceptance Criteria

1. THE Intelligence_Governance SHALL require Current_Approval of the Intelligence_Record before accepting any Blueprint_Module approval.
2. THE Intelligence_Governance SHALL require Current_Approval of exactly the seven defined Blueprint_Modules before accepting Gap_Record or Strategy_Record approval.
3. THE Intelligence_Governance SHALL require Current_Approval of each referenced Gap_Record before accepting Opportunity_Record approval.
4. THE Intelligence_Governance SHALL require Current_Approval of the selected Strategy_Record before accepting Opportunity_Record approval.
5. THE Intelligence_Governance SHALL require an explicit Opportunity_Record approval independent of upstream approvals.
6. WHEN an Intelligence_Record revision changes, THE Intelligence_Governance SHALL mark dependent Blueprint_Module, Gap_Record, Strategy_Record, and Opportunity_Record approvals stale.
7. WHEN a Blueprint_Module revision changes, THE Intelligence_Governance SHALL mark dependent Gap_Record, Strategy_Record, and Opportunity_Record approvals stale.
8. WHEN a referenced Gap_Record or selected Strategy_Record revision changes, THE Intelligence_Governance SHALL mark the dependent Opportunity_Record approval stale.
9. WHEN Formal_Generation is requested, THE Intelligence_Governance SHALL compare current dependency revisions and digests with the approved Dependency_Snapshot.
10. IF the approved Dependency_Snapshot differs from any current dependency, THEN THE Content_Agent_API SHALL reject Formal_Generation with `INTELLIGENCE_DEPENDENCY_STALE`.
11. WHEN a dependency approval becomes stale, THE Intelligence_Governance SHALL retain the prior approval as immutable history.

### Requirement 5: Isolate research from runtime behavior

**User Story:** As a release reviewer, I want research separated from prompt construction, so that unapproved experiments cannot alter production generation.

#### Acceptance Criteria

1. THE Research_Governance SHALL exclude Research_Record prose, claims, sources, datasets, experiments, and results from direct prompt construction.
2. WHEN a Calibration_Proposal is approved, THE Research_Governance SHALL bind the Calibration_Proposal to one approved Release before runtime use.
3. WHEN an approved Calibration_Proposal is bound to the Active_Release, THE Runtime_Contract_Guard SHALL resolve the calibrated parameter with Calibration_Proposal provenance.
4. IF a Calibration_Proposal is unapproved, unbound, or bound to a non-active Release, THEN THE Runtime_Contract_Guard SHALL reject the Calibration_Proposal for runtime parameter resolution.
5. WHEN Runtime_Snapshot includes a calibrated parameter, THE Content_Agent SHALL record the resolved value and Calibration_Proposal provenance.
6. THE Research_Governance SHALL retain prior research and calibration approvals without rewriting historical decisions.

### Requirement 6: Bind active formula, release, and runtime contracts

**User Story:** As a release manager, I want generation bound to one validated active runtime contract, so that caller input or configuration drift cannot change an approved run.

#### Acceptance Criteria

1. WHEN a Release is submitted for approval, THE Runtime_Contract_Guard SHALL validate the Formula identifier and Formula digest against the current Formula record.
2. WHEN a Release is submitted for approval, THE Runtime_Contract_Guard SHALL validate execution-policy, prompt, parameter-policy, and Evidence_Catalog versions and digests against current runtime definitions.
3. WHEN an approved Release is activated, THE Runtime_Contract_Guard SHALL repeat complete Runtime_Contract validation.
4. WHEN Formal_Generation is accepted, THE Runtime_Contract_Guard SHALL repeat complete Runtime_Contract validation.
5. WHEN a Worker prepares provider dispatch, THE Runtime_Contract_Guard SHALL compare Runtime_Snapshot with the current Active_Release and Runtime_Contract.
6. WHEN a Formula is activated or automatically upgraded, THE Runtime_Contract_Guard SHALL archive every active Release bound to another Formula identifier or digest before accepting another Formal_Generation.
7. WHEN a caller supplies a draft, archived, or non-release Formula selection, THE Content_Agent_API SHALL resolve Formal_Generation exclusively from the Active_Release Formula.
8. IF no Active_Release exists for Formal_Generation, THEN THE Content_Agent_API SHALL reject the request with `ACTIVE_RELEASE_REQUIRED`.
9. IF a requested or resolved Formula conflicts with the Active_Release Formula, THEN THE Content_Agent_API SHALL reject the request with `RELEASE_FORMULA_CONFLICT`.
10. IF a Runtime_Contract value differs from the Active_Release binding, THEN THE Content_Agent_API SHALL reject the operation with `RUNTIME_CONTRACT_STALE`.
11. WHERE a legacy Project requires a baseline Release, THE Runtime_Contract_Guard SHALL create the immutable baseline only after validating the current Runtime_Contract.

### Requirement 7: Detect evidence-catalog semantic drift

**User Story:** As an operator, I want startup to detect catalog/runtime divergence, so that evidence provenance cannot disagree with runtime formula semantics.

#### Acceptance Criteria

1. THE Evidence_Catalog SHALL represent F10 with the equation `Cref=Rollout(ρC|Role×Scene×Register×Topology×Gap)`.
2. THE Evidence_Catalog SHALL retain catalog revision `r14` as the initial authoritative revision for the approved F10 semantics.
3. WHEN Content_Agent starts, THE Runtime_Contract_Guard SHALL compare the default catalog version and raw catalog digest with runtime configuration.
4. WHEN Content_Agent starts, THE Runtime_Contract_Guard SHALL compare Formula presence, equations, and semantic fingerprints with runtime handlers.
5. THE Runtime_Contract_Guard SHALL evaluate raw-byte digest consistency independently from semantic consistency.
6. IF either catalog digest consistency or semantic consistency fails, THEN THE Content_Agent SHALL report `EVIDENCE_CATALOG_DRIFT` and remain not ready.
7. WHILE Evidence_Catalog drift exists, THE Content_Agent SHALL keep Formal_Generation unavailable.
8. WHEN a catalog import has a new digest, THE Content_Agent SHALL create a versioned catalog record.
9. WHEN a catalog import matches or differs from a prior digest, THE Content_Agent SHALL preserve prior claim and source records without overwrite.

### Requirement 8: Freeze one complete three-candidate generation snapshot

**User Story:** As an editor, I want every formal run to be reproducible, so that all three Candidates can be traced to one approved input and runtime state.

#### Acceptance Criteria

1. WHEN Formal_Generation passes preflight, THE Content_Agent SHALL persist one immutable Runtime_Snapshot before acknowledging accepted work.
2. THE Runtime_Snapshot SHALL contain Project identifier, Release identifier/version, Formula identifier/digest, execution-policy version/digest, prompt version/digest, parameter-policy version/digest, and Evidence_Catalog version/digest.
3. THE Runtime_Snapshot SHALL contain resolved parameters, parameter provenance, Latest_Knowledge entries, approved Opportunity_Record Dependency_Snapshot, and approved image-observation entries.
4. WHEN Runtime_Snapshot contains an image-observation entry, THE Content_Agent SHALL record the source asset digest, observation version, observation digest, and Artifact_State.
5. THE Runtime_Snapshot SHALL set Candidate count to exactly three.
6. WHEN Formal_Generation completes, THE Content_Agent SHALL persist exactly three distinct Candidates associated with the same Runtime_Snapshot.
7. IF fewer or more than three Candidates are available, THEN THE Content_Agent SHALL keep the Formal_Generation outside the completed state.
8. IF Candidate results reference mixed Runtime_Snapshots, THEN THE Content_Agent SHALL reject the result commit.
9. IF preflight fails, THEN THE Content_Agent SHALL keep provider dispatch absent.
10. WHEN a Worker detects Runtime_Contract drift before provider dispatch, THE Work_Coordinator SHALL move the Work_Item to a typed non-completed failure state.

### Requirement 9: Couple credentials to authorized endpoint provenance

**User Story:** As a security operator, I want each credential restricted to its authorized origin, so that Workspace configuration cannot redirect deployment secrets.

#### Acceptance Criteria

1. THE Secure_Model_Gateway SHALL mediate every generation, revision, project-analysis, image-analysis, and provider-validation model request.
2. WHEN platform mode is selected, THE Secure_Model_Gateway SHALL pair the Platform_Credential only with the Deployment_Managed_Origin.
3. WHEN platform mode contains a Workspace `base_url`, THE Secure_Model_Gateway SHALL treat the Workspace `base_url` as inactive legacy data.
4. WHEN BYOK mode is selected, THE Secure_Model_Gateway SHALL pair the Workspace endpoint only with the BYOK_Credential owned by the same Workspace.
5. IF credential provenance and endpoint provenance do not form an authorized pair, THEN THE Secure_Model_Gateway SHALL reject the request with `PROVIDER_CREDENTIAL_ENDPOINT_MISMATCH`.
6. WHEN credential/endpoint coupling fails, THE Secure_Model_Gateway SHALL keep Secret_Bearing_Request dispatch absent.
7. THE Content_Agent SHALL keep Platform_Credential, BYOK_Credential, authorization header, and plaintext secret values absent from API responses.

### Requirement 10: Enforce fail-closed endpoint and SSRF policy

**User Story:** As a deployment operator, I want outbound model traffic constrained by canonical network policy, so that DNS, redirects, or Workspace input cannot reach unauthorized targets.

#### Acceptance Criteria

1. THE Endpoint_Allowlist SHALL use exact Canonical_Origin matching, including effective port, as the default BYOK rule.
2. WHERE no Endpoint_Exception applies, THE Endpoint_Allowlist SHALL authorize only public HTTPS Canonical_Origins.
3. WHERE an internal gateway is required, THE Deployment_Configuration SHALL require an Endpoint_Exception naming the exact Canonical_Origin and each permitted CIDR or Network_Class.
4. THE Content_Agent SHALL reserve creation and modification of Endpoint_Allowlist rules for a Deployment_Operator.
5. IF a provider URL contains user information or a fragment, THEN THE Secure_Model_Gateway SHALL reject the URL with `PROVIDER_ENDPOINT_INSECURE`.
6. IF no enabled Endpoint_Allowlist rule matches the Canonical_Origin, THEN THE Secure_Model_Gateway SHALL reject the endpoint with `PROVIDER_ENDPOINT_NOT_ALLOWED`.
7. WHEN a hostname resolves, THE Secure_Model_Gateway SHALL evaluate every DNS_Address_Record address against the effective Network_Class and CIDR policy.
8. IF any resolved address is unauthorized by the effective rule, THEN THE Secure_Model_Gateway SHALL block dispatch with `PROVIDER_NETWORK_TARGET_BLOCKED`.
9. WHEN connection begins, THE Secure_Model_Gateway SHALL revalidate DNS or pin the previously approved address set for that request.
10. THE Secure_Model_Gateway SHALL deny redirects by default.
11. WHERE a deployment rule enables redirects, THE Secure_Model_Gateway SHALL reauthorize every redirect hop against an explicitly named Canonical_Origin.
12. WHEN a redirect crosses Canonical_Origins, THE Secure_Model_Gateway SHALL remove the prior authorization credential before evaluating another request.
13. IF a redirect hop is not explicitly authorized, THEN THE Secure_Model_Gateway SHALL block the hop with `PROVIDER_REDIRECT_BLOCKED`.
14. THE Secure_Model_Gateway SHALL enforce a positive finite request timeout and a positive finite maximum response size from Deployment_Configuration.
15. WHEN a response exceeds the configured maximum response size, THE Secure_Model_Gateway SHALL terminate response processing with a typed redacted error.
16. WHEN endpoint authorization fails, THE Secure_Model_Gateway SHALL record the policy rule or block reason without recording secrets, full prompts, Project_Knowledge text, or image bytes.

### Requirement 11: Fail closed on insecure production runtime configuration

**User Story:** As a production operator, I want unsafe runtime defaults rejected, so that deployment mistakes cannot silently weaken authentication or network boundaries.

#### Acceptance Criteria

1. WHEN Content_Agent starts in production, THE Content_Agent SHALL validate bootstrap credentials, encryption secrets, session secrets, secure-cookie policy, trusted-proxy policy, and API bind configuration.
2. IF a required production secret is missing or matches a documented predictable default, THEN THE Content_Agent SHALL report `INSECURE_PRODUCTION_CONFIG` and remain not ready.
3. WHEN Content_Agent runs in production, THE Content_Agent SHALL issue session cookies with `Secure` and `HttpOnly` attributes.
4. WHEN forwarded headers are processed, THE Content_Agent SHALL trust only the bounded proxy set declared by Deployment_Configuration.
5. THE Content_Agent SHALL use a dedicated API bind-host setting rather than the generic project `HOST` value.
6. WHEN Content_Agent runs in a container deployment, THE Deployment_Configuration SHALL set API bind host to `0.0.0.0` with precedence over project `.env` values.
7. WHEN Content_Agent runs with local defaults outside a container, THE Content_Agent SHALL bind the API to a loopback address.
8. WHEN production runtime validation fails, THE Content_Agent_API SHALL return only redacted configuration categories and correlation data.

### Requirement 12: Propagate online repository failures without fallback

**User Story:** As an online user, I want persistence failures shown honestly, so that fixtures or local objects are not mistaken for server data.

#### Acceptance Criteria

1. WHEN an Online_Repository read succeeds, THE Online_Repository SHALL return only data received from Content_Agent_API.
2. WHEN an Online_Repository read fails, THE Online_Repository SHALL return an explicit repository error to the UI.
3. WHEN an Online_Repository read fails and Last_Known_Data exists, THE UI SHALL label Last_Known_Data with the current error state.
4. WHEN an Online_Repository read fails without Last_Known_Data, THE UI SHALL display an unavailable state rather than an empty-success collection.
5. WHEN an Online_Repository write fails, THE UI SHALL keep the proposed mutation outside persisted state.
6. WHEN an Online_Repository write fails, THE UI SHALL preserve retryable user input and display the typed retryability state.
7. WHEN an Online_Repository write fails, THE UI SHALL keep success notices and locally fabricated persisted identifiers absent.
8. WHEN Content_Agent_API becomes unavailable, THE UI SHALL retain Repository_Mode as `online` until the user explicitly enters `/demo`.
9. IF a Demo_Entity identifier reaches an online API boundary, THEN THE Content_Agent_API SHALL reject the request with `DEMO_ENTITY_ONLINE_REJECTED`.
10. WHEN online persistence fails, THE Content_Agent_API SHALL use `ONLINE_REPOSITORY_UNAVAILABLE` for the stable repository-unavailable condition.

### Requirement 13: Require explicit isolated demo mode

**User Story:** As an evaluator, I want demo behavior visibly isolated and explicitly entered, so that demonstration state cannot be confused with online persistence.

#### Acceptance Criteria

1. THE Demo_Repository SHALL be available only when Deployment_Configuration enables Demo_Capability.
2. WHEN a user explicitly enters `/demo` while Demo_Capability is enabled, THE UI SHALL select Repository_Mode `demo` for that session.
3. IF a user requests `/demo` while Demo_Capability is disabled, THEN THE Content_Agent SHALL return `DEMO_MODE_DISABLED`.
4. WHILE Repository_Mode is `demo`, THE UI SHALL display a persistent demo banner and repository-mode label in every view.
5. WHEN Demo_Repository creates an entity, THE Demo_Repository SHALL assign an identifier beginning with `demo:`.
6. THE Demo_Repository SHALL keep demo state in session-only memory by default.
7. THE Demo_Repository SHALL keep automatic browser-local persistence absent.
8. THE Demo_Repository SHALL keep automatic online persistence absent.
9. WHEN Demo_Repository produces a result, THE UI SHALL state that server generation, Automated_Gate execution, persistence, Candidate_Review, and publication did not occur.
10. WHEN a demo session ends, THE Demo_Repository SHALL make the session-only state unavailable to a later session.
11. WHEN an online operation fails, THE Content_Agent SHALL require explicit `/demo` entry rather than selecting Demo_Repository automatically.

### Requirement 14: Bind append-only review decisions to canonical content

**User Story:** As a publication reviewer, I want a decision tied to exact publish-visible content, so that later edits cannot inherit approval.

#### Acceptance Criteria

1. THE Candidate_Digest_Service SHALL include every publish-visible title, body, tag, comment-reference, evidence declaration, Unknown_Value declaration, boundary declaration, image brief, and artifact-status claim in Canonical_Publish_Content.
2. THE Candidate_Digest_Service SHALL exclude Candidate_Review identifiers, audit timestamps, display-only ordering metadata, and Canonical_Content_Digest from Canonical_Publish_Content.
3. THE Candidate_Digest_Service SHALL sort object keys, preserve array order, normalize Unicode, and encode null and Unknown_Value explicitly.
4. WHEN a Candidate_Review is submitted, THE Candidate_Digest_Service SHALL compute Canonical_Content_Digest on the server from current persisted Candidate content.
5. WHEN an export is requested, THE Candidate_Digest_Service SHALL recompute Canonical_Content_Digest on the server from current persisted Candidate content.
6. WHEN Candidate_Review is accepted, THE Candidate_Review_Service SHALL append the decision with Candidate identifier, Canonical_Content_Digest, reviewer identifier, note, exception metadata, and timestamp.
7. THE Candidate_Review_Service SHALL keep prior Candidate_Review rows immutable.
8. WHEN any canonical publish-visible field changes, THE Candidate_Digest_Service SHALL produce a Canonical_Content_Digest different from the prior digest.
9. WHEN the current Canonical_Content_Digest differs from an approved Candidate_Review digest, THE Candidate_Review_Service SHALL derive `stale_approval`.
10. WHEN multiple Candidate_Review rows share the current Canonical_Content_Digest, THE Candidate_Review_Service SHALL derive Current_Review from the latest decision for that digest.
11. IF a supplied or recorded review digest differs from the server-computed digest, THEN THE Content_Agent_API SHALL reject the operation with `CANDIDATE_CONTENT_DIGEST_MISMATCH`.

### Requirement 15: Separate automated validation from accountable human approval

**User Story:** As a governance owner, I want human approval independent from automated checks and the creator where possible, so that publish authorization is accountable.

#### Acceptance Criteria

1. THE Content_Agent SHALL interpret `validation.valid=true` only as an Automated_Gate pass.
2. WHEN a Candidate passes the Automated_Gate without Current_Review approval, THE Content_Agent SHALL derive the Candidate as not publish-ready.
3. THE Candidate_Review_Service SHALL require the dedicated Candidate_Review_Permission for every Candidate_Review decision.
4. WHILE at least two Eligible_Reviewers exist in a Workspace, THE Candidate_Review_Service SHALL require the Candidate reviewer identifier to differ from the Creator identifier.
5. WHILE exactly one Eligible_Reviewer exists in a Workspace, THE Candidate_Review_Service SHALL permit the sole Eligible_Reviewer to proceed only through Single_User_Exception.
6. WHEN Single_User_Exception is used, THE Candidate_Review_Service SHALL require explicit confirmation and a non-empty reason.
7. WHEN Single_User_Exception is used, THE Audit_Service SHALL record actor, reason, Candidate identifier, Canonical_Content_Digest, and Eligible_Reviewer count.
8. IF at least two Eligible_Reviewers exist, THEN THE Candidate_Review_Service SHALL reject Single_User_Exception.
9. WHEN a Candidate contains a Dynamic_Claim, THE Candidate_Review_Service SHALL present each Dynamic_Claim as a review reason regardless of Project_Knowledge Provenance.
10. WHEN a legacy Candidate has no Candidate_Review row, THE Candidate_Review_Service SHALL derive `unreviewed` without creating synthetic approval.
11. WHERE the legacy `qualityStatus` field remains available, THE Content_Agent SHALL label the field as an Automated_Gate compatibility field rather than as quality or publication approval.

### Requirement 16: Separate review-draft and publish-ready exports

**User Story:** As an exporter, I want explicit draft and publish purposes, so that unapproved content cannot appear publication-ready.

#### Acceptance Criteria

1. WHEN an export request omits purpose, THE Export_Service SHALL apply purpose `review`.
2. WHEN purpose is `review` and the Candidate passes the Automated_Gate, THE Export_Service SHALL authorize a Review_Draft regardless of Current_Review approval state.
3. IF the Candidate fails the Automated_Gate, THEN THE Export_Service SHALL reject export with `AUTOMATED_VALIDATION_REQUIRED`.
4. WHEN Export_Service produces a human-readable Review_Draft, THE Export_Service SHALL place the exact Draft_Watermark on every page or section.
5. WHEN Export_Service produces a JSON Review_Draft, THE Export_Service SHALL place top-level `publicationStatus` with exact value `draft`.
6. WHEN Export_Service produces a JSON Review_Draft, THE Export_Service SHALL place top-level `watermark` with the exact Draft_Watermark value.
7. WHEN Export_Service produces a Review_Draft, THE Export_Service SHALL include the current human review state in export metadata.
8. WHEN purpose is `publish`, THE Export_Service SHALL require Current_Review decision `approved` for the current Canonical_Content_Digest.
9. WHEN purpose is `publish`, THE Export_Service SHALL require the Clean_Export_Permission from the requesting Principal.
10. IF no approved Current_Review exists, THEN THE Export_Service SHALL reject publish export with `CANDIDATE_REVIEW_REQUIRED`.
11. IF a prior approval exists only for another Canonical_Content_Digest, THEN THE Export_Service SHALL reject publish export with `CANDIDATE_REVIEW_STALE`.
12. WHEN Export_Service produces a Publish_Ready_Export, THE Export_Service SHALL include approval metadata and omit Draft_Watermark.
13. WHEN Current_Review is `changes_requested` or `rejected`, THE Export_Service SHALL keep Publish_Ready_Export unavailable.
14. WHEN Export_Service completes or blocks an export, THE Audit_Service SHALL record purpose, Candidate identifier, Canonical_Content_Digest, export digest when present, and policy outcome.

### Requirement 17: Persist work and enforce exclusive leases

**User Story:** As an operator, I want work durable across restarts and exclusive across instances, so that process loss cannot erase or duplicate execution.

#### Acceptance Criteria

1. WHEN generation, project analysis, or image analysis is accepted, THE Work_Coordinator SHALL persist a Work_Item before Content_Agent_API acknowledges acceptance.
2. WHEN a Worker claims queued work, THE Work_Coordinator SHALL acquire one Lease through a conditional SQLite transaction.
3. THE Work_Coordinator SHALL set Lease duration to 60 seconds.
4. WHILE a Work_Attempt is active, THE Worker SHALL emit Heartbeat every 20 seconds.
5. WHEN a valid Heartbeat is accepted, THE Work_Coordinator SHALL extend Lease expiry from the current heartbeat time according to the 60-second duration.
6. WHEN a Worker mutates Work_Item, Dispatch_Checkpoint, result, coverage, quota, or terminal state, THE Work_Coordinator SHALL verify the current Lease_Token.
7. IF Lease_Token is stale or mismatched, THEN THE Work_Coordinator SHALL reject the mutation with `WORK_LEASE_CONFLICT`.
8. WHILE one unexpired Lease exists for a Work_Item, THE Work_Coordinator SHALL keep every competing claim unsuccessful.
9. THE Work_Coordinator SHALL store Lease_Token as a cryptographic hash where persistence permits.
10. WHILE a provider request is in progress, THE Work_Coordinator SHALL keep SQLite write transactions closed.
11. WHEN Worker execution advances, THE Work_Coordinator SHALL persist `intent_recorded`, `request_sent`, `response_received`, and `committed` Dispatch_Checkpoints at the corresponding boundaries.

### Requirement 18: Recover only proven-safe work attempts

**User Story:** As a cost and reliability owner, I want crash recovery to distinguish safe replay from uncertain dispatch, so that retries do not duplicate provider work.

#### Acceptance Criteria

1. THE Work_Coordinator SHALL cap automatic Work_Attempts at three per Work_Item.
2. WHEN an expired Lease has Dispatch_Checkpoint `not_started`, THE Work_Coordinator SHALL requeue the Work_Item only when fewer than three automatic Work_Attempts have occurred.
3. WHEN an expired Lease has `intent_recorded` and durable evidence proves no request was sent, THE Work_Coordinator SHALL requeue the Work_Item only when fewer than three automatic Work_Attempts have occurred.
4. WHEN an expired Lease has `response_received` with a valid staged response digest, THE Work_Coordinator SHALL recover by local validation and idempotent commit without another provider dispatch.
5. WHEN an expired Lease has `request_sent`, `outcome_unknown`, or insufficient no-send evidence, THE Work_Coordinator SHALL classify the Work_Item as `interrupted_review_required`.
6. WHEN a Work_Item is `interrupted_review_required`, THE Work_Coordinator SHALL keep automatic provider replay absent.
7. WHEN Uncertain_Dispatch is detected, THE Content_Agent_API SHALL expose `WORK_OUTCOME_UNCERTAIN` to an authorized operator.
8. WHEN an authorized operator retries interrupted work, THE Work_Coordinator SHALL create a linked new Work_Attempt.
9. WHEN an authorized retry lacks provider proof that idempotency-key reuse is safe, THE Work_Coordinator SHALL assign a new provider Idempotency_Key.
10. WHEN Content_Agent restarts, THE Work_Coordinator SHALL apply checkpoint-based recovery rather than marking all queued or running Work_Items failed.
11. WHEN a queued Work_Item is cancelled before dispatch, THE Work_Coordinator SHALL transition the Work_Item to `cancelled` without provider dispatch.

### Requirement 19: Make work commits and side effects idempotent

**User Story:** As a multi-instance operator, I want replay-safe state transitions, so that retries and restarts cannot duplicate Candidates, coverage, or terminal effects.

#### Acceptance Criteria

1. WHEN a Work_Item is enqueued with a new Idempotency_Key, THE Work_Coordinator SHALL bind the Idempotency_Key to work type, aggregate scope, and payload digest.
2. WHEN enqueue repeats with the same Idempotency_Key and payload digest, THE Work_Coordinator SHALL return the existing Work_Item.
3. IF an Idempotency_Key is reused with a different payload digest, THEN THE Content_Agent_API SHALL reject the operation with `IDEMPOTENCY_CONFLICT`.
4. WHEN result commit repeats with the same Work_Item, operation key, and result digest, THE Work_Coordinator SHALL return the previously committed result without duplicate Candidate rows.
5. WHEN coverage commit repeats with the same Work_Item, operation key, and payload digest, THE Work_Coordinator SHALL keep coverage rows unchanged after the first commit.
6. WHEN completion repeats with the same Work_Item and result digest, THE Work_Coordinator SHALL keep one terminal completion event.
7. IF result commit repeats with a different result digest for the same operation key, THEN THE Work_Coordinator SHALL reject the commit with `IDEMPOTENCY_CONFLICT`.
8. WHEN a recovered staged response commits successfully, THE Work_Coordinator SHALL use the original result operation key.

### Requirement 20: Reserve and settle quota in provider-dispatch units

**User Story:** As a Workspace owner, I want concurrent provider usage accounted exactly once, so that Workers cannot overbook quota or charge queued-only work.

#### Acceptance Criteria

1. THE Quota_Ledger SHALL use one Dispatch_Unit for each provider HTTP request as the initial enforcement unit.
2. WHEN a Work_Item requires platform quota, THE Quota_Ledger SHALL reserve projected Dispatch_Units atomically before dispatch capacity is promised.
3. IF a Quota_Reservation would exceed available Dispatch_Units, THEN THE Content_Agent_API SHALL reject the reservation with `QUOTA_RESERVATION_FAILED`.
4. WHEN Quota_Reservation fails, THE Secure_Model_Gateway SHALL keep provider dispatch absent.
5. WHEN a queued Work_Item has not dispatched a provider request, THE Quota_Ledger SHALL keep settled usage unchanged.
6. WHEN a provider HTTP request is authorized for dispatch, THE Quota_Ledger SHALL bind one Dispatch_Unit to a unique dispatch Idempotency_Key.
7. WHEN a dispatch outcome is known, THE Quota_Ledger SHALL settle the corresponding Dispatch_Unit exactly once.
8. WHEN reserved Dispatch_Units are no longer required, THE Quota_Ledger SHALL release unused units exactly once.
9. WHEN a dispatch outcome is unknown, THE Quota_Ledger SHALL retain the corresponding reservation in `outcome_unknown` state.
10. WHILE a quota outcome remains unknown, THE Quota_Ledger SHALL keep the held Dispatch_Unit unavailable for another reservation.
11. WHEN an unknown outcome is reconciled, THE Quota_Ledger SHALL append one idempotent reconciliation entry.
12. THE Quota_Ledger SHALL preserve `available + reserved + settled = Accounting_Total` after every ledger operation.
13. THE Quota_Ledger SHALL retain optional Provider_Usage_Metadata fields without using Provider_Usage_Metadata to change Dispatch_Unit enforcement in the initial version.
14. IF an unknown outcome prevents safe quota reuse, THEN THE Content_Agent_API SHALL expose `QUOTA_RECONCILIATION_REQUIRED`.

### Requirement 21: Apply additive transactional SQLite evolution

**User Story:** As a data owner, I want schema changes to preserve history and recover atomically, so that hardening does not rewrite governance evidence.

#### Acceptance Criteria

1. THE Migration_Service SHALL implement additive, versioned SQLite migrations for Candidate_Review, Work_Item, Lease, Dispatch_Checkpoint, Quota_Reservation, Quota_Ledger, and Runtime_Snapshot data.
2. WHEN Migration_Service runs inside an existing transaction, THE Migration_Service SHALL use nested-safe savepoint semantics.
3. IF a migration step fails, THEN THE Migration_Service SHALL roll back the complete migration transaction.
4. IF migration fails, THEN THE Content_Agent SHALL remain not ready.
5. THE Migration_Service SHALL keep historical Project_Knowledge, Candidate_Review, research approval, release approval, and completed generation rows unchanged by migration.
6. THE Migration_Service SHALL enforce foreign keys and explicit delete behavior for new durable records.
7. THE Migration_Service SHALL enforce unique Idempotency_Key constraints for work and quota operations in their defined scopes.
8. THE Migration_Service SHALL enforce one current Lease per Work_Item and one Dispatch_Checkpoint per Work_Attempt.
9. THE Migration_Service SHALL index current Knowledge_Version selection, Candidate_Review digest lookup, queued work claim order, Lease expiry, and quota reconciliation lookup.
10. THE Content_Agent SHALL use SQLite WAL mode and a bounded busy timeout for concurrent instances.
11. WHILE a Lease or quota Compare_And_Swap transaction is open, THE Content_Agent SHALL keep network I/O outside the transaction.
12. WHEN timestamps are persisted, THE Content_Agent SHALL use the repository’s existing ISO-8601 convention.

### Requirement 22: Preserve compatible history and fail-safe rollback behavior

**User Story:** As an upgrade operator, I want legacy records preserved with fail-safe defaults, so that migration cannot synthesize approvals or unsafe execution.

#### Acceptance Criteria

1. WHEN a legacy Candidate has no Candidate_Review, THE Candidate_Review_Service SHALL derive `unreviewed`.
2. WHEN a legacy Candidate passes the Automated_Gate, THE Export_Service SHALL permit only a Review_Draft until Current_Review approval exists.
3. WHEN a legacy platform-mode Workspace contains a custom provider URL, THE Content_Agent SHALL retain the URL as inactive audit data.
4. WHEN a legacy BYOK endpoint is first used after upgrade, THE Secure_Model_Gateway SHALL evaluate the endpoint against the current Endpoint_Allowlist.
5. WHEN legacy fixture behavior remains available, THE Content_Agent SHALL expose the fixture only through explicitly entered Demo_Repository mode.
6. WHEN a legacy queued Work_Item has durable evidence of no dispatch, THE Migration_Service SHALL classify the Work_Item as recoverable queued work.
7. WHEN a legacy running Work_Item lacks safe dispatch evidence, THE Migration_Service SHALL classify the Work_Item as `interrupted_review_required`.
8. THE Migration_Service SHALL preserve legacy completed and failed work as historical records.
9. WHEN a production upgrade begins, THE Implementation_Workflow SHALL require an offline copy of the Content_Agent data directory before writers start on the upgraded schema.
10. THE Migration_Service SHALL omit destructive down-migrations.
11. WHEN application rollback is required after schema use, THE Implementation_Workflow SHALL stop new Worker claims before restoring the pre-upgrade data-directory copy with the prior application image.
12. WHEN review support is disabled during rollback, THE Content_Agent SHALL keep clean publish export disabled rather than treating missing review support as approval.
13. WHEN Batch_E is rolled back, THE Implementation_Workflow SHALL prevent process-local legacy Workers from operating on a database containing Uncertain_Dispatch work.
14. THE Implementation_Workflow SHALL preserve Batch_A behavior during Batch_B through Batch_E rollback.

### Requirement 23: Expose stable API and error contracts

**User Story:** As a client developer, I want stable typed interfaces, so that governance and recovery outcomes can be handled without parsing messages.

#### Acceptance Criteria

1. THE Content_Agent_API SHALL accept Formal_Generation through `POST /api/projects/:projectId/generations` only after full integrity preflight, Runtime_Snapshot persistence, quota reservation, and durable Work_Item enqueue.
2. WHERE provider-policy validation is exposed, THE Content_Agent_API SHALL route `POST /api/projects/:projectId/provider/validate` through Secure_Model_Gateway without revealing resolved secrets.
3. THE Content_Agent_API SHALL expose Candidate_Review history through `GET /api/generations/:jobId/candidates/:candidateId/reviews`.
4. THE Content_Agent_API SHALL append Candidate_Review decisions through `POST /api/generations/:jobId/candidates/:candidateId/reviews` using the server-computed current Canonical_Content_Digest.
5. THE Content_Agent_API SHALL expose explicit review or publish export purpose through `GET /api/generations/:jobId/candidates/:candidateId/export`.
6. THE Content_Agent_API SHALL expose authorized linked retries through `POST /api/work-items/:id/retry`.
7. THE Content_Agent_API SHALL expose non-secret migration, catalog, queue, and quota-reconciliation readiness through `GET /health`.
8. WHEN Content_Agent_API rejects a request, THE Content_Agent_API SHALL return API_Error.
9. THE Content_Agent_API SHALL map stable error codes to HTTP statuses according to the normative Error Mapping table.
10. WHERE a legacy Batch_A client requires transitional compatibility, THE Content_Agent_API SHALL preserve the documented legacy 400 response only until the typed status migration is completed and regression-tested.

#### Normative Error Mapping

| HTTP | Code |
|---:|---|
| 400 | `KNOWLEDGE_SELECTION_INVALID` |
| 409 | `KNOWLEDGE_VERSION_STALE` |
| 409 | `INTELLIGENCE_DEPENDENCY_STALE` |
| 409 | `ACTIVE_RELEASE_REQUIRED` |
| 409 | `RELEASE_FORMULA_CONFLICT` |
| 409 | `RUNTIME_CONTRACT_STALE` |
| 503 | `EVIDENCE_CATALOG_DRIFT` |
| 400 | `PROVIDER_ENDPOINT_INSECURE` |
| 403 | `PROVIDER_ENDPOINT_NOT_ALLOWED` |
| 403 | `PROVIDER_NETWORK_TARGET_BLOCKED` |
| 403 | `PROVIDER_REDIRECT_BLOCKED` |
| 409 | `PROVIDER_CREDENTIAL_ENDPOINT_MISMATCH` |
| 503 | `INSECURE_PRODUCTION_CONFIG` |
| 503 | `ONLINE_REPOSITORY_UNAVAILABLE` |
| 403 | `DEMO_MODE_DISABLED` |
| 409 | `DEMO_ENTITY_ONLINE_REJECTED` |
| 422 | `AUTOMATED_VALIDATION_REQUIRED` |
| 409 | `CANDIDATE_REVIEW_REQUIRED` |
| 409 | `CANDIDATE_REVIEW_STALE` |
| 409 | `CANDIDATE_CONTENT_DIGEST_MISMATCH` |
| 409 | `WORK_LEASE_CONFLICT` |
| 409 | `WORK_OUTCOME_UNCERTAIN` |
| 409 | `IDEMPOTENCY_CONFLICT` |
| 429 | `QUOTA_RESERVATION_FAILED` |
| 409 | `QUOTA_RECONCILIATION_REQUIRED` |

### Requirement 24: Provide redacted audit, metrics, and readiness evidence

**User Story:** As an operator, I want observable governance and work state without sensitive content leakage, so that failures can be diagnosed safely.

#### Acceptance Criteria

1. WHEN runtime preflight, release validation, catalog validation, endpoint authorization, repository mode, Candidate_Review, export, work transition, or quota transition occurs, THE Audit_Service SHALL record a typed structured event.
2. WHEN Audit_Service records an event, THE Audit_Service SHALL include correlation identifier and applicable Workspace, Project, job, Candidate, Work_Item, policy-rule, and digest-prefix identifiers.
3. THE Audit_Service SHALL keep API keys, authorization headers, full prompts, Project_Knowledge bodies, image bytes, and plaintext BYOK_Credentials absent from logs and audit events.
4. THE Content_Agent SHALL report preflight rejections, catalog/runtime mismatches, endpoint-policy blocks, online repository failures, demo sessions, Candidate review states, export outcomes, queue states, lease expirations, recovery outcomes, quota states, reconciliation age, attempt distribution, and idempotent replay counts as metrics.
5. THE Content_Agent SHALL distinguish process liveness from Readiness.
6. IF schema migration, SQLite access, or Evidence_Catalog consistency is unusable, THEN THE Content_Agent SHALL report not ready.
7. WHEN External_Provider is unavailable, THE Content_Agent SHALL report degraded dependency status without automatically making the API process not ready.
8. WHEN health is queried without an explicit provider validation request, THE Secure_Model_Gateway SHALL keep credential-bearing provider probes absent.
9. WHEN queue health is queried, THE Content_Agent SHALL report queued, leased, running, interrupted, oldest-age, Lease-expiry, and reconciliation-backlog summaries without sensitive payloads.

### Requirement 25: Validate without real secrets, production data, external providers, or unrelated repository changes

**User Story:** As the repository owner, I want implementation and validation isolated from production and unrelated work, so that hardening can be verified without collateral changes or external side effects.

#### Acceptance Criteria

1. WHILE Spec_Workflow creates design, requirements, or task artifacts, THE Spec_Workflow SHALL limit file changes to Spec_Directory.
2. WHILE implementation or validation runs, THE Validation_Harness SHALL use synthetic environment maps instead of a Real_Environment_File.
3. WHILE database tests run, THE Validation_Harness SHALL use temporary non-production SQLite databases.
4. WHILE provider tests run, THE Validation_Harness SHALL route requests through Fake_Provider_Transport instead of an External_Provider.
5. WHEN restart or multi-instance behavior is tested, THE Validation_Harness SHALL use temporary databases and Fake_Provider_Transport.
6. THE Implementation_Workflow SHALL preserve unrelated Parent_Repository worktree and index state without restore, deletion, staging, commit, or rewrite.
7. THE Implementation_Workflow SHALL limit dependency changes to exact-pinned packages required by approved implementation or regression tests.
8. WHEN automated test suites run, THE Validation_Harness SHALL use single-run modes rather than watch or interactive modes.
9. WHEN final validation executes, THE Validation_Harness SHALL run in order: Batch_A targeted tests and API typecheck; Batch_B security tests; Batch_C repository tests; Batch_D review/export tests; Batch_E migration/concurrency/restart/quota tests; complete core/web/API tests; workspace typecheck; production build; non-mutating repository-status review.
10. WHEN final repository status is reviewed, THE Validation_Harness SHALL confirm that changes are limited to intended `content-agent` paths for the approved implementation context.
11. THE Validation_Harness SHALL keep production credentials, production data, and real provider calls absent from every automated validation stage.

## Governing-Invariant Traceability

| Design invariant | Requirements preserving the invariant |
|---|---|
| I-01 — provenance and human review for dynamic claims | 2, 15, 16 |
| I-02 — intelligence → seven modules → gap/strategy → independent opportunity | 4 |
| I-03 — research isolation and release-bound calibration | 5 |
| I-04 — frozen release/formula/contracts/knowledge/opportunity/images/parameters and three Candidates | 6, 7, 8 |
| I-05 — Unknown_Value preservation | 2, 8, 14 |
| I-06 — artifact lifecycle distinctions | 2, 8, 13 |
| I-07 — diagnostics do not establish quality or effect | 2, 15 |
| I-08 — Automated_Gate is not publication approval | 15, 16 |
| I-09 — explicit isolated demo; no fallback | 12, 13 |
| I-10 — runtime-contract agreement at approval, activation, acceptance, and execution | 6, 7, 8 |
| I-11 — credential/endpoint provenance coupling | 9, 10 |
| I-12 — clean export requires current digest-bound approval | 14, 15, 16 |
| I-13 — exclusive Lease and no blind uncertain retry | 17, 18 |
| I-14 — idempotent quota and concurrent conservation | 19, 20, 21 |

## Batch Traceability

| Batch | Requirements | Required status treatment |
|---|---|---|
| Batch_A | 3, 6, 7, 21 | Implemented before this spec; final recheck required |
| Batch_B | 9, 10, 11, 23, 24 | Design/read only at requirements derivation; implementation follows Batch_A baseline |
| Batch_C | 12, 13 | Not started at requirements derivation |
| Batch_D | 14, 15, 16 | Not started at requirements derivation |
| Batch_E | 17, 18, 19, 20, 21 | Not started at requirements derivation |
| Final validation | 1, 25 | Runs only after ordered A→E work and starts with Batch_A recheck |
