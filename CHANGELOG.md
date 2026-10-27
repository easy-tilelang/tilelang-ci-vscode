# Changelog

## 0.1.1

- Fix missing personal PR highlighting for fork workflows whose Actions PR references and upstream commit associations are both empty, including tile-ai/tilelang#3636.
- Discover PR candidates using the fork owner and branch, then require matching base repository, fork repository, branch, and head commit before association. Incomplete pages and ambiguous results remain unconfirmed.
- Preserve running jobs in My PRs without inventing waiting positions, and add regression coverage for fork identity, reused branches, pagination failures, query encoding, and shared head lookups.

## 0.1.0

Initial release candidate of TileLang CI.

- Add a standalone VS Code resource queue dashboard with a native sidebar and status bar.
- Support public and private github.com repositories through VS Code GitHub authentication.
- Group active jobs by normalized runner label sets, preserve resource positions under filtering, and summarize the jobs associated with your PRs.
- Keep merged/closed PR jobs, older commits, unranked jobs, and active workflows without jobs visible.
- Add local/Remote SSH Git metadata discovery, saved repository selection, and explicit fallback for unsupported Git configuration.
- Add focused/visible refresh scheduling, conditional requests, cancellation, rate-limit waits, and separate partial queue/PR-association diagnostics.
- Bundle an offline demo, Chinese and English UI/documentation, theme-aware responsive styles, regression tests, CI checks, and VSIX packaging.

This version reads CI metadata only. It does not rerun, cancel, approve, or trigger workflows; display archived logs; predict start times; monitor hidden views; or send background notifications. Marketplace publication and live account/Remote SSH release acceptance remain maintainer steps.
