# wingdiff

Wingdiff is a guided, evidence-backed tour of a pull request. It helps an engineer understand a change by behavior, data flow, and risk; investigate the exact supporting code; and publish a thoughtful review to GitHub.

This repository currently contains the Phase 0 experience prototype described in the [product plan](./PRODUCT_PLAN.md). It uses a realistic cross-file PR fixture to exercise the complete review loop:

- Technical brief with stated intent, inferred behavior, topology, and risk map
- Five-stop semantic tour with exact diff evidence and provenance labels
- Line selection, flags, contextual investigation, and draft review comments
- Full evidence Browse mode
- Review desk with coverage, summary, inline comments, and disposition
- Dark/light themes, keyboard navigation, responsive layout, and local persistence

GitHub submission and model responses are deliberately simulated in this phase. The prototype is intended to validate the interaction before real acquisition and analysis infrastructure is restored.

## Run locally

Requires Node.js 22.12+ (excluding Node 23) or Node.js 24+.

```bash
npm install
npm run dev
```

Vite serves the application at `http://127.0.0.1:4173`.

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
