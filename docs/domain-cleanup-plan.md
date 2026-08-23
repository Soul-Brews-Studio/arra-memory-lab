# Domain cleanup plan

Date: 2026-08-23

## Locked behavior

Before editing:

```text
28 tests passed / 0 failed / 100 expectations
TypeScript typecheck passed
Worker and client production builds passed
```

The existing integration suite locks authority writes, supersession snapshots, trace-result retention, fail-safe trace IDs, revision invalidation, CAS conflicts, observation races, indexing races, and snapshot-bound forget.

## Smell-focused passes

1. Extract limits and pure normalization/ranking/manifest helpers into `src/domain-utils.ts`.
2. Extract reusable Drizzle reads and trace query builders into `src/db/queries.ts`.
3. Keep `src/domain.ts` responsible for mutation ordering, transactions, failure semantics, and public orchestration.
4. Re-export moved public helpers from `src/domain.ts` so callers do not break.

## Non-goals

- no schema, migration, API, MCP, OAuth, ranking, retention, or UI behavior change
- no new dependency
- no abstraction over Drizzle or D1
- no repository/service class

## Verification

- targeted domain tests
- full `npm run check`
- Wrangler deploy dry-run
- `git diff --check`
- deployed keyword recall + trace lookup smoke
