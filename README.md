# wingdiff

Wingdiff is a guided, evidence-backed tour of a pull request. It helps an engineer understand a change by behavior, data flow, and risk; investigate the exact supporting code; and publish a thoughtful review to GitHub.

This repository contains the local-first review foundation described in the [product plan](./PRODUCT_PLAN.md), plus a realistic cross-file fixture for exercising the complete review loop:

- A default **Since your review** route that isolates the two areas changed after the reviewed head
- An **Entire PR** backstop that keeps reviewed-but-unchanged areas visible
- Finding continuity that shows whether earlier concerns still apply or appear addressed
- A focused summary and semantic tour with exact diff evidence
- Line selection, flags, contextual investigation, and draft review comments
- Full evidence Browse mode
- Review desk with coverage, summary, inline comments, and disposition
- Dark/light themes, keyboard navigation, responsive layout, and local persistence

Real pull requests can be acquired and turned into grounded guided tours. Review comments can be staged and resumed locally; GitHub review submission remains simulated. Contextual investigation defaults to the locally installed Codex CLI using its existing ChatGPT sign-in. Direct OpenAI and Anthropic APIs remain optional; the demo uses clearly labeled fixture answers when no provider is available.

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

Wingdiff reads metadata through `gh`, fetches missing objects into private `refs/wingdiff/pull/...` references, and builds the diff from exact pinned base/head SHAs. It does not checkout the PR, modify the worktree or index, or execute pull-request code. Acquired metadata, evidence, generated tours, and review checkpoints are stored in a local SQLite database. Set `WINGDIFF_DATA_DIR` to choose its location.

From the real-PR Summary, choose a configured model and select **Generate guided review**. The model organizes the validated diff into semantic stops, ranks concrete findings by severity, and references opaque evidence anchors. Wingdiff rejects the result unless every changed file is covered and every claim or finding resolves to an exact known anchor. Generated tours are pinned to the acquired head SHA and can be resumed locally.

Comments drafted from a real tour are also pinned to the acquired diff. Wingdiff records the GitHub side and exact line range, verifies the terminal line fingerprint against the canonical pull-request diff, and stores accepted drafts in the local SQLite session. A stale, cross-hunk, wrong-side, or non-diff anchor is rejected before it can enter the review queue.

### Review author updates

After visiting every stop, select **Complete review** to create an explicit checkpoint at the current head SHA. **Check for updates** then reacquires the pull request without checking it out or running its code. If the author pushed a new head, Wingdiff opens a new local session in **Since your review** mode using the exact reviewed-head → current-head diff.

The **Entire PR** scope remains available as an independent backstop. Update and full-PR tours are generated and persisted separately, and every acquired revision is retained under a private `refs/wingdiff/pull/.../revisions/...` reference so a later force-push does not erase the comparison baseline.

## Portable, local-first AI

Wingdiff has no hosted service dependency. By default, its loopback server delegates model work to Codex CLI, which keeps authentication in the supported CLI credential store instead of asking Wingdiff to handle a key.

```bash
codex login
codex login status
npm run dev
```

Wingdiff invokes `codex exec` in an isolated temporary directory with an ephemeral session, a read-only sandbox, user/project customization disabled, and a structured-output schema. Review evidence is sent over stdin rather than command-line arguments. The model request still reaches the provider configured by Codex, so your organization’s model and data-use policies still apply.

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

API keys are read only by the loopback Node server and are never returned to browser JavaScript. OpenAI API requests use the Responses API with `store: false`; tour generation uses strict structured output and investigations stream. Wingdiff never reads or copies Codex CLI credentials.

## Verify

```bash
npm test
npm run typecheck
npm run build
```

The tests enforce the product's grounding contract: claims must resolve to real evidence, generated tours must cover every changed file, diff ranges must be internally consistent, revision coverage must partition the full fixture tour, findings must remain attached to known stops, and staged comments must match the pinned GitHub diff side and line fingerprint.

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
