# wingdiff

Wingdiff is a guided, evidence-backed tour of a pull request. It helps an engineer understand a change by behavior, data flow, and risk; investigate the exact supporting code; and publish a thoughtful review to GitHub.

This repository currently contains the Phase 0 experience prototype described in the [product plan](./PRODUCT_PLAN.md). It uses a realistic cross-file PR fixture and an author follow-up to exercise the complete review loop:

- A default **Since your review** route that isolates the two areas changed after the reviewed head
- An **Entire PR** backstop that keeps reviewed-but-unchanged areas visible
- Finding continuity that shows whether earlier concerns still apply or appear addressed
- A focused summary and semantic tour with exact diff evidence
- Line selection, flags, contextual investigation, and draft review comments
- Full evidence Browse mode
- Review desk with coverage, summary, inline comments, and disposition
- Dark/light themes, keyboard navigation, responsive layout, and local persistence

GitHub submission and tour generation are deliberately simulated in this phase. Contextual investigation defaults to the locally installed Codex CLI using its existing ChatGPT sign-in. Direct OpenAI and Anthropic APIs remain optional; without an available provider Wingdiff falls back to clearly labeled fixture answers.

## Run locally

Requires Node.js 22.12+ (excluding Node 23) or Node.js 24+.

```bash
npm install
npm run wingdiff
```

The launcher starts Wingdiff at `http://127.0.0.1:4173` and opens the local landing screen. Paste a GitHub pull request URL, or open the fixture directly:

```bash
npm run wingdiff -- --demo
npm run wingdiff -- https://github.com/owner/repository/pull/123
npm run wingdiff -- 123 # resolves the repository from the current checkout
```

The built server package also exposes the eventual `wingdiff` binary. Use `npm run dev` when working on the UI without automatic browser launch.

### Read-only PR acquisition

For a real pull request, launch Wingdiff from a matching local checkout with an authenticated GitHub CLI:

```bash
gh auth status
npm run wingdiff -- https://github.com/owner/repository/pull/123
```

Wingdiff reads metadata through `gh`, fetches missing objects into private `refs/wingdiff/pull/...` references, and builds the diff from exact pinned base/head SHAs. It does not checkout the PR, modify the worktree or index, or execute pull-request code. Acquired metadata, evidence, and review checkpoints are stored in a local SQLite database. Set `WINGDIFF_DATA_DIR` to choose its location.

The real-PR view currently provides the authentic Summary and Browse evidence surfaces. Semantic tour generation and GitHub review submission remain intentionally disconnected.

## Portable, local-first AI

Wingdiff has no hosted service dependency. By default, its loopback server delegates model work to Codex CLI, which keeps authentication in the supported CLI credential store instead of asking Wingdiff to handle a key.

```bash
codex login
codex login status
npm run dev
```

Wingdiff invokes `codex exec` in an isolated temporary directory with an ephemeral session, a read-only sandbox, and user/project customization disabled. Review evidence is sent over stdin rather than command-line arguments. The model request still reaches the provider configured by Codex, so your organization’s model and data-use policies still apply.

Direct API access is an optional fallback. Copy the example environment file and add either key:

```bash
cp .env.example .env
```

Available Codex/OpenAI models:

- `gpt-6-sol` — default balance of review quality, speed, and cost
- `gpt-6-astra` — highest-capability option for difficult reviews
- `gpt-6-luna` — fast, cost-efficient investigations
- `gpt-5.3-codex` — Codex-tuned coding model

Claude Sonnet 4.6 and Opus 4.6 remain available through the same provider interface. Select Codex CLI, OpenAI API, or Anthropic API plus the model and supported reasoning effort from the model control in the top bar.

API keys are read only by the loopback Node server and are never returned to browser JavaScript. OpenAI API requests use the Responses API with streaming and `store: false`. Wingdiff never reads or copies Codex CLI credentials.

## Verify

```bash
npm test
npm run typecheck
npm run build
```

The fixture tests enforce the product's grounding contract: claims must resolve to real evidence, diff ranges must be internally consistent, revision coverage must partition the full tour, and findings must remain attached to known stops.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `j` / `k` | Next / previous tour stop |
| `a` | Investigate the active evidence |
| `c` | Draft a comment |
| `f` | Flag the current stop |
| `d` | Toggle tour and Browse mode |
| `r` | Open the review desk |
| `Escape` | Close the active overlay |
