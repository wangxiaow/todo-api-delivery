# Platform template for one delivery

This repository is the *platform* half of a Delivery-Assured delivery: the trusted CI
tooling, the workflows and the operation pack. The deliverable itself lives in
`project/`, and it starts out empty on purpose — a session bootstraps it in the documented
order:

```
project/.agent/project.yaml → project/ci/verifier.yaml → project/tests/acceptance/spec
  → project/.agent/CONTRACT.yaml     (writing the Contract closes the bootstrap window)
```

## What is here

| Path | Role |
|---|---|
| `project/` | the delivered product; bootstrapped by a session, verified by CI |
| `packages/delivery-assured/` | the operation pack the verifier and the CI tools run |
| `ci/tools/` | the collector, the promotion job, the staging and diff tools |
| `.github/workflows/verify.yml` | the trusted verification: freeze candidate + standard, stage, verify, write evidence |
| `.github/workflows/promote.yml` | the collector (`workflow_run`), the state bootstrap and the Promotion job |
| `plugins/`, `tools/` | repository material `ci-stage.mjs` copies verbatim; kept non-empty |

Nothing here is evidence. Evidence is produced only by a real `verify` run, and a Baseline
is advanced only by the Promotion job.
