# wingdiff

Wingdiff is a guided, evidence-backed tour of a pull request. It helps an engineer understand a change by behavior, data flow, and risk; investigate the exact supporting code; and publish a thoughtful review to GitHub.

This repository currently contains the Phase 0 experience prototype described in the [product plan](./PRODUCT_PLAN.md). It uses a realistic cross-file PR fixture to exercise the complete review loop:

- Review summary with ranked findings, stated intent, implementation shape, and risk map
- Five-stop semantic tour with exact diff evidence and provenance labels
- Line selection, flags, contextual investigation, and draft review comments
- Full evidence Browse mode
- Review desk with coverage, summary, inline comments, and disposition
- Dark/light themes, keyboard navigation, responsive layout, and local persistence

GitHub submission and tour generation are deliberately simulated in this phase. Contextual investigation defaults to the locally installed Codex CLI using its existing ChatGPT sign-in. Direct OpenAI and Anthropic APIs remain optional; without an available provider Wingdiff falls back to clearly labeled fixture answers.

## Run locally

Requires Node.js 22.12+ (excluding Node 23) or Node.js 24+.

```bash
npm install
npm run dev
```

The local Wingdiff server hosts the API and Vite application at `http://127.0.0.1:4173`.

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

The fixture tests enforce the product's grounding contract: claims must resolve to real evidence, diff ranges must be internally consistent, and risks and tour stops must reference valid topology nodes.

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
