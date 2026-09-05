# Local reviews with Robin

This clone adds a `robin` CLI. It runs from any Git repository or linked worktree,
including subdirectories. It reads local changes, calls your configured model,
and prints the review. It does not create workflows, post comments, fetch refs,
or change your index or working files.

## Install from this clone

```bash
cd ~/code/robin
npm ci
npm run build:cli
mkdir -p ~/.local/bin
ln -s "$PWD/bin/robin.js" ~/.local/bin/robin
```

Ensure `~/.local/bin` is on your PATH. If `robin` already exists, inspect it before
replacing it. Run `npm run build:cli` again after changing the CLI source.
The existing `robin-review` command remains the upstream GitHub Action installer.

## Configure a model

Set `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY` in `~/.config/robin/.env`
for automatic loading from every worktree, or in your shell environment.
Use your provider's OpenAI-compatible API URL and model ID. Keep keys out of
tracked files and command arguments. Shell variables override the global file;
CLI flags override both. Repository `.env` and `.env.local` files are not loaded.
The global file supports dotenv quotes, comments, and optional `export` prefixes.
Values are not evaluated as shell commands or expanded as variable references.
Only the three provider variables are loaded. Keep the file readable only by you,
for example with `chmod 600 ~/.config/robin/.env`.

For an already running local Ollama server:

```bash
export LLM_BASE_URL=http://localhost:11434/v1
export LLM_MODEL=your-installed-model
```

Localhost endpoints do not require a key. Remote endpoints require `LLM_API_KEY`.
Use `--base-url` and `--model` to override the environment for one run.
Only a local model keeps review content entirely on your computer. A remote model
receives the filtered diff and any reviewer instructions you explicitly supply.

## Review your work

Run these commands in the repository or worktree being reviewed:

```bash
# Preview exactly which diff will be sent, without calling the model
robin review --base origin/main --dry-run

# Branch changes since the merge base, including tracked local edits
robin review --base origin/main

# Only the staged version of changes, excluding unstaged edits
robin review --staged

# Staged and unstaged tracked edits against HEAD, the default scope
robin review --working-tree

# JSON on stdout, progress/errors on stderr
robin review --base origin/main --format json --fail-on high

# Include repository-specific reviewer instructions
robin review --base origin/main --instructions AGENTS.md
```

`--base`, `--staged`, and `--working-tree` are mutually exclusive. `--base` uses
local refs without fetching, so update the base ref yourself when needed. It
compares the current files to the merge base, including committed branch changes
and tracked uncommitted edits. Untracked files are excluded. Stage new files to
review them. Unmerged conflicts cause an error. Submodule contents are excluded.
`--staged` also works before a repository's first commit; other scopes need HEAD.

Robin reads `skip-paths` and `max-diff-size` from `.github/robin.yml` in the target
worktree. Upstream default filters exclude common lockfiles and generated output.
The default limit is 50,000 diff characters. Oversized diffs fail before a model
request rather than silently truncating. Override with `--max-diff-size`.
A preview follows the same filters and size limit. Review instructions are only
loaded when passed with `--instructions`, relative to the repository root.

Formats are `text`, `markdown`, and `json`. Text and Markdown use the same readable
layout. JSON includes `status`, `summary`, severity arrays, and `removedFiles` for
completed reviews. Skipped reviews return `status: "skipped"`, `summary`, and
`removedFiles`; previews return `status: "preview"`, `diff`, and `removedFiles`.

Exit codes:

- `0`: review completed below the threshold, preview completed, or nothing to review.
- `1`: findings reached `--fail-on high`, `medium`, or `low`, including higher severities.
- `2`: invalid input, Git error, provider failure, or invalid model response.

The default threshold is `none`. Suggestions never fail a review. Findings remain
model judgments, and this reviewer sees the diff rather than the full repository.

## Development

```bash
npm test -- --runInBand
npm run lint
npm run build:cli
```

Local CLI integration tests use temporary repositories, a linked worktree, and a
loopback HTTP server. They need no real API key or network provider.

## Pre-push hooks

`robin pre-push "$@"` consumes Git's ref updates on stdin. It reviews each pushed
branch at its exact commit with `--head`, using `--fail-on high`. Existing branches
compare against the previous remote tip's merge base. New branches use the
remote's locally cached default branch, or `ROBIN_BASE` when explicitly set.
Fetch missing base refs before pushing. Tags and deleted branches are skipped.
`ROBIN_SKIP=1` bypasses the review explicitly. Provider failures block the push.

For a manual committed-only review, use:

```bash
robin review --base origin/main --head HEAD
```

The interactive CLI animates a spinner on stderr while the provider is working.
Redirected stderr uses a plain progress line. JSON stdout stays free of animation.
