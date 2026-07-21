# Agent Core

`@content-agent/agent-core` contains the framework-independent content generation domain layer. It has no runtime dependency on NestJS, React, a database, or a vector store.

## Main entry points

- `indexKnowledgeSource`, `loadKnowledgeDirectory`, and `selectKnowledgeContext` index MD/TXT sources and choose full or progressive context under a token budget.
- `buildKnowledgeLedger` preserves facts, cases, inferences, hypotheses, unknowns, prohibited claims, and unresolved conflicts.
- `DEFAULT_FORMULA_VERSION`, `validateFormulaDsl`, and `evaluateFormula` provide the F01-F43 seed and a bounded JSON-AST interpreter. No source text or arbitrary code is evaluated.
- `planning.ts` filters and ranks proofable topic cards, creates three same-topic structural orchestrations, and records deterministic coverage signatures without embeddings or a vector store.
- `PromptMessage` accepts text and `image_url` parts; the compatible client maps them to Responses or Chat Completions wire formats while keeping request bodies ASCII-safe.
- `createDefaultGenerationConfig` and `resolveGenerationConfig` resolve system → workspace → project → task settings.
- `OpenAICompatibleClient` supports OpenAI Responses (default) and Chat Completions transports. The caller selects the model.
- `ContentGenerationAgent.generate` produces exactly three seeded `ContentPackage` candidates. With no provider it uses a deterministic local demonstration path.
- `ContentGenerationAgent.revise` and `analyzeRevisionDependencies` rerun only the selected candidate and affected content channels.
- `GENERATION_PARAMETER_REGISTRY` is the single UI/runtime parameter source, including controls, Chinese novice help, increase/decrease effects, formula links, channel links, and evidence status.
- `BUILT_IN_GENERATION_PRESETS` and `BUILT_IN_STYLE_PROFILES` provide safe defaults; `compileGenerationParameters` resolves them into an effective config, Chinese behavior instructions, formula results, channel allocation, and an auditable impact report.
- `CONFIRMED_REFERENCE_SAMPLE_BASELINE` contains only aggregate descriptive statistics for the 70-reference sample. It intentionally contains no source copy and is not a quality or platform rule.

```ts
import {
  ContentGenerationAgent,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
} from "@content-agent/agent-core";

const config = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
config.task.theme = "需要补全的信息主题";

const result = await new ContentGenerationAgent({ modelProvider }).generate({
  jobId: "job-1",
  config,
  formulaVersion: DEFAULT_FORMULA_VERSION,
  knowledge: indexedDocuments,
  parameterSelection: {
    presetId: "balanced_information",
    styleProfileId: "natural_concise",
  },
});
```

Every generated package includes `resolutionSnapshot` and `impactReport`. F32/F33 emit ordered review-component metadata with `status: "unknown"`, `value: null`, and `aggregation: "components_only"`. Their `emphasis` values change only display/manual-review order; they never change prompts, thresholds, validation, candidate selection, or generation, and the core never invents a total score.

Run `npm test -w @content-agent/agent-core` for deterministic offline tests.
