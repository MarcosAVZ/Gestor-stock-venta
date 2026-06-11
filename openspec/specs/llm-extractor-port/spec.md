# LLM Extractor Port Specification

## Purpose

Declare an `LLMExtractor` port as a sibling to the existing `OCRExtractor`
port. This cycle defines the interface only — no provider is chosen, no
adapter is implemented, and the port is NOT wired into the OCR pipeline.
The interface exists so that a future change can plug in an LLM fallback
without re-shaping the application's dependencies.

The port is intentionally declared-but-unused: a top-of-file comment
documents the future plan and the non-wiring decision so readers do not
mistake the file for a missing implementation.

## Requirements

### Requirement: LLMExtractor interface declared
A TypeScript interface `LLMExtractor` MUST be declared in
`apps/bot/src/application/ocr/interfaces/LLMExtractor.ts`. The interface
MUST expose a method that consumes a complete text blob and returns a
structured purchase data result, and MUST export a typed error class
`LLMAvailabilityError` so that future implementers have a typed error to
throw when the upstream LLM provider is unreachable.

#### Scenario: The file exports the right shape
- WHEN the file is read
- THEN it exports an interface `LLMExtractor` with at least
  `extractFromText(textoCompleto: string): Promise<OCRResult>`
- AND it exports a class `LLMAvailabilityError`

### Requirement: The port is NOT wired into the pipeline this cycle
The interface MUST exist but MUST NOT be referenced by
`ExtractPurchaseData.ts` or the DI container in this cycle. The only
callers of `LLMExtractor` in this cycle are the interface file itself
and the optional noop test double.

#### Scenario: No use of LLMExtractor inside ExtractPurchaseData
- GIVEN a search of `apps/bot/src/application/ocr/ExtractPurchaseData.ts` for the symbol `LLMExtractor`
- WHEN the search is run
- THEN zero matches are returned

#### Scenario: Container does not register LLMExtractor
- GIVEN a search of `apps/bot/src/config/container.ts` for the symbol `LLMExtractor`
- WHEN the search is run
- THEN zero matches are returned

### Requirement: The port is structurally satisfiable
A noop test double MUST compile against the `LLMExtractor` interface,
proving the interface shape is implementable without dragging in a
real provider.

#### Scenario: Noop implementation compiles under tsc
- GIVEN a test file that declares a class implementing `LLMExtractor` with `extractFromText` returning a stub `OCRResult` and `LLMAvailabilityError` re-exported
- WHEN `tsc --noEmit` is run on the workspace
- THEN the command exits 0

### Requirement: Top-of-file comment documents the future plan
The interface file MUST begin with a comment block that describes the
intentional non-wiring, the intended future use as a fallback, and the
fact that no provider is chosen yet.

#### Scenario: Comment block is present and accurate
- WHEN the file is read
- THEN the first 20+ lines are a comment block describing:
  - This port was declared in the `ocr-parser-label-aware` change.
  - No implementation exists in this cycle; only the interface and the error class.
  - The future use case: when the heuristics parser returns 0 products or low confidence, the use case MAY fall back to calling `LLMExtractor.extractFromText`.
  - No provider is chosen yet (Anthropic, OpenAI, etc.); a future change will add a concrete adapter plus API key configuration and any required cost / latency tracking.
