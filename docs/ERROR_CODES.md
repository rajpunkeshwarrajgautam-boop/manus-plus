# Error Code Catalog

Backend APIs return stable machine-readable `errorCode` values with human-readable `error` messages.

Source of truth:

- `config/error-codes.json` stores the canonical catalog.
- `scripts/verify-error-codes.mjs` verifies service usage against the catalog.

Validation command:

- `npm run verify:error-codes`
- `npm run verify:error-codes:runtime` (requires running APIs)

CI runs this check to prevent:

- introducing an `errorCode` in service code without catalog entry
- stale catalog entries that are no longer used
- duplicate code definitions in catalog
- regressions where runtime responses stop returning expected `errorCode` values
