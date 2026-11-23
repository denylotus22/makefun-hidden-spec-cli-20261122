# makefun-hidden-spec-cli-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/denylotus22/makefun-hidden-spec-cli-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/denylotus22/makefun-hidden-spec-cli-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that reads AI-written edits in all four formats
agent harnesses meet in the wild — unified diffs (often with wrong line
numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON — and applies them to a tree of text files, to one written
specification. It finds the lines an edit names even when the model drifted
their whitespace or indentation, and it changes every file or none: if any
edit fails to match, nothing is written. Node 22 standard library only, no
dependencies, deterministic output.

## Run it

```sh
node main.ts patch.diff                 # apply a patch file
node main.ts < patch.diff               # or read the patch from stdin
node main.ts --check patch.diff         # dry run: report, write nothing
node main.ts --strict patch.diff        # exact matching only (tier 0)
node main.ts --format=unified patch.diff  # force one format: auto (default),
                                          # unified, search-replace, v4a, json
```

The patch is read in one of four formats — unified diff, SEARCH/REPLACE
blocks, V4A patches, or JSON tool calls — detected automatically. Each edit is
matched at the first of three tiers (exact, trailing whitespace, leading and
trailing whitespace), so drifted indentation still lands; if any edit fails,
nothing is written and every failure is reported. Exit codes: 0 applied,
1 some edit failed, 2 usage / unreadable patch / no format detected / parse
error.

---

<sub>Entered on [make.fun](https://make.fun/?ref=y40c9kj2&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
