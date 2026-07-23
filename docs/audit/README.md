# Formula and Prompt Audit

This directory contains the strict audit and its controlled implementation record. The original evidence catalog remains an audit artifact; approved production changes are tracked separately.

- `formula-prompt-audit.md` explains the end-to-end findings in Chinese.
- `formula-evidence-catalog.json` maps all F01–F43 plus M-CLOSE/M-DISCOVERY to code reality, evidence, limitations, fingerprints and proposed status.
- `formula-review-checklist.md` contains the approved route into later production changes and records the completion state of each review item.
- `p0-implementation-report.md` records the completed R01–R06 behavior, migration boundaries and verification.
- `r07-implementation-report.md` records the F01–F43 execution-truth registry and audit UI contract.
- `r08-implementation-report.md` records the audience-scenario, prior-knowledge and unknown-history separation.
- `r09-core-implementation-report.md` records the F17/F21 manual calculator contract across Core, API and Web.
- `r10-implementation-report.md` records the source-image, plan, brief, final-asset, entry-snapshot and deployment lifecycle.
- `r11-implementation-report.md` records the non-causal opportunity-ranking heuristic, provenance and selection-audit contract.
- `r12-implementation-report.md` records the F30 manual TrendFit scenario, source-identity boundary, non-consumption contract and separate qualified-incremental-reach protocol.
- `r13-implementation-report.md` records the F32/F33 display/manual-review ordering contract, unknown/null components, prompt isolation, fail-closed history handling and non-quality-score UI.
- `cref-contract-v1-1-implementation-report.md` records the comment-reference (Cref) v1.1 contract: publisher answer identity, node kinds/boundary/function, multi-turn growth switch, section-level knowledge evidence, validator recalibration, plus the release re-activation and P0 data-confirmation runbook.

Validate the catalog from `content-agent/`:

```powershell
node -e "const c=require('./docs/audit/formula-evidence-catalog.json'); console.log(c.formulaEvidence.length)"
```

The expected formula entry count is `45`: 43 numbered formulas and two unnumbered methods. A custom formula may inherit an audit record only when its ID and complete canonical semantic fingerprint match the catalog.
