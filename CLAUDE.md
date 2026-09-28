# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

A Node.js CLI (`code-brain-angular`) that statically analyzes TypeScript/JavaScript — with Angular
support — and produces **CIIR** (Code Intelligence Intermediate Representation). It is the
TypeScript/Angular counterpart of the sibling `code-csharp-ciir` (reference implementation) and
`code-java-ciir`, and feeds the code-brain stack (`code-ciir-indexer`, `code-ciir-api`,
`code-rag-front`).

**The contract is king.** `schemas/ciir.schema.json` is a verbatim copy of the C# repo's schema
(1.2) — do not edit it here; contract changes start in `code-csharp-ciir`. Identity
(`sha256(language|project|kind|canonicalName)`), hashing, output files and the `semantic-v1`
`embeddingText` section order must stay identical to the C# generator. Language/framework-specific
facts go under `extensions.typescript` / `extensions.angular`, never as new top-level properties.

## Specifications

Specs live in `.specs/` (Portuguese, like the sibling repos). Read `.specs/01-spec-inicial.md`
before new work and add new specs there. `docs/ciir-specification.md` explains the TS/Angular →
CIIR mapping.

## Architecture (hexagonal)

| Module | Role |
|---|---|
| `src/core` | CIIR model, identity, hashing, modifier order, `embeddingText` builder. Imports nothing outside itself and `node:*`. |
| `src/application` | Ports (`CodeAnalyzer`, `CiirWriter`, `ArtifactWriter`, `CiirUploader`, ...), input resolution, project discovery, `AnalyzeInputHandler`. Never imports `typescript` or `@angular/*`. |
| `src/typescript` | The only module allowed to import `typescript` and `@angular/compiler`. `angular/` holds the Angular-specific extraction. |
| `src/configuration`, `src/serialization`, `src/indexer-client` | Driven adapters. |
| `src/cli` | Composition root (`composition.ts`) and CLI. No analysis logic. |

`tests/application/application.test.ts` has an architecture-boundary test enforcing the import
rules. A new language/framework generator = a new `CodeAnalyzer` registered in `composition.ts`.

## Key invariants in `src/typescript` (easy to break in a refactor)

- `SymbolNaming.documentKindOf` decides both which declarations get a document **and** which
  relation targets get a `target.id`; never classify in two places.
- Project symbols are named from their **primary declaration** (implementation first, then
  (file, position) order) so relation ids match document ids; external symbols use the overload
  resolved at the call site.
- `DocumentBuilder.claim` guarantees one document per `ts.Symbol` (overloads, get/set, merged
  declarations → `additionalSourceLocations`).
- Module paths are relative to the **project root**; `source.path` to the **analysis root**.
- TypeScript is pinned to **6.0.x**: TS 7 (native) only exposes an `unstable/*` API.

## Tech stack

Node ≥ 20, TypeScript (ESM, `NodeNext`), `typescript` 6.0 Compiler API, `@angular/compiler`,
`commander`, `jsonc-parser`. Tests: Vitest + Ajv. Only free/open-source libraries; prefer the latest
compatible versions.

## Commands

```bash
npm ci
npm run build                 # dist/
npm run typecheck             # must be clean (src + tests)
npm test                      # all suites; the CLI suite builds dist/ itself
npx vitest run tests/typescript -t "<name>"
npm run format                # prettier (fixtures/ excluded)
node dist/cli/main.js fixtures/basic-angular-app --output ciir-output
```

Reuse `fixtures/basic-angular-app` (app + `shared-lib` library) for new analyzer scenarios rather
than adding fixtures. `tests/helpers.ts` provides `FIXTURE`/`REPOSITORY_ROOT` paths, silent
logger/progress stubs, `composeHandler` and `temporaryDirectory()` — reuse these instead of
re-wiring the composition root per test.

## Distribution and CI

Published to npm as `code-brain-angular` (`npx code-brain-angular`), see
`.specs/02-ci-e-publicacao.md`. The version comes only from the `vX.Y.Z` tag — never hard-code it
in `package.json` (`0.0.0-local`). Validation runs on Forgejo (`.forgejo/workflows/ci.yml`),
the mirror to GitHub respects the weekday 20:00–07:00 window (`mirror-to-github.yml`), and
publishing happens on GitHub (`.github/workflows/release.yml`, environment `npm`).
`scripts/verify-package.sh <version>` must keep passing: it guards the tarball contents, the
`npx` install and a smoke test.

## Git commits

Conventional Commits (`feat(angular): ...`, `fix(relations): ...`). Use `!`/`BREAKING CHANGE:` for
incompatible changes to the CIIR output or CLI behavior.
