# .github

Read `.github/agent-governance/AGENTS.md` before working in this repository.

This repository is the canonical owner of organization-wide GitHub metadata, reusable workflows, governance contracts, synchronization policy, and shared agent governance for `yohn-jp`.

## Canon

- Accepted Issues / Implementation contracts define task scope.
- `.github/inari/**` is canonical for shared Issue/PR governance contracts.
- `.github/agent-governance/**` is canonical for organization agent policy and Skills.
- `.github/sync*.yml` and the sync workflow define distribution to consumer repositories.
- Repository-specific product behavior belongs in the consumer repository, not here.

## Validation

Run `pnpm run validate` and `pnpm test` for the relevant change.
