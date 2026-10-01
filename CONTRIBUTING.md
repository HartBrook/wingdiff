# Contributing to Wingdiff

Thanks for helping make pull-request review more understandable and grounded.

## Before you start

- Use GitHub Discussions for design questions and early proposals.
- Search existing issues before opening a new one.
- Report vulnerabilities privately according to [SECURITY.md](./SECURITY.md).
- Keep changes focused. Large product-direction changes should have an issue or
  discussion before implementation.

By participating, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Development setup

You need Git, Node.js 22.13+ (excluding Node 23) or Node.js 24+, npm, and the
GitHub CLI for real pull-request acquisition. Codex CLI is the default model
transport; direct provider keys are optional.

```bash
git clone https://github.com/HartBrook/wingdiff.git
cd wingdiff
npm ci
npm run wingdiff -- --demo
```

Copy `.env.example` to `.env` only when you need optional provider or runtime
configuration. Never commit credentials, model output containing confidential
source, or a local Wingdiff database.

## Project layout

- `apps/server` contains the CLI, loopback server, acquisition, persistence,
  provider, and GitHub-review code.
- `apps/web` contains the React review interface and fixture experience.
- `e2e` contains Playwright coverage for the end-to-end review flow.

## Validate a change

Run the same checks used by CI:

```bash
npm test
npm run typecheck
npm run build
npx playwright install chromium # first browser run only
npm run test:e2e
```

Add or update tests when changing behavior. Documentation-only changes do not
need synthetic tests, but links and commands should still be checked.

## Pull requests

1. Explain the user-visible problem and the chosen approach.
2. Keep unrelated cleanup out of the pull request.
3. Call out privacy, provider, persistence, or GitHub-write implications.
4. Include screenshots for visible UI changes.
5. Confirm the checklist in the pull-request template.

Maintainers may ask for a smaller change, additional evidence, or a design
discussion before merging. Contributions are licensed under the repository's
MIT License.

Maintainers publishing a release should follow
[docs/PUBLISHING.md](./docs/PUBLISHING.md).
