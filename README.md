# wingdiff

[![CI](https://github.com/HartBrook/wingdiff/actions/workflows/ci.yml/badge.svg)](https://github.com/HartBrook/wingdiff/actions/workflows/ci.yml)
[![CodeQL](https://github.com/HartBrook/wingdiff/actions/workflows/codeql.yml/badge.svg)](https://github.com/HartBrook/wingdiff/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**Understand a pull request before you approve it.**

Wingdiff turns a pull request into a guided tour, ordered by behavior, data flow, and risk instead of by file name. Every explanation links to the exact lines that support it. You investigate, you write the comments, and you publish one review to GitHub as yourself.

Free and open source under the MIT License. Runs entirely on your machine with the model access you already have.

```bash
npx wingdiff https://github.com/owner/repository/pull/123
```

> [!NOTE]
> Wingdiff is pre-1.0 software. Review the generated evidence and final GitHub
> payload before publishing.

![Wingdiff guided review interface](./docs/images/wingdiff-demo.png)

## Why Wingdiff

AI review bots made review comments cheap. They did not make changes easier to understand. Pull requests keep getting larger, more of them are written by coding agents, and the person who approves still owns the outcome. Wingdiff is built for that person.

- **No bot comments on your pull request.** Wingdiff never posts on its own and never approves anything. Its findings are for you to confirm, dismiss, or turn into a comment in your own words. Nothing reaches GitHub until you publish, and it arrives as your review.
- **Every explanation is checked against the diff.** Wingdiff rejects a generated tour unless every claim and finding resolves to an exact line range in the pinned diff, and every changed file is covered. The raw diff is always one keystroke away.
- **Coverage you can trust.** Wingdiff records which tour stops you actually visited, not which files scrolled past. Approving with unseen stops, open flags, or high-severity findings requires an explicit acknowledgement.
- **Built for large and agent-written changes.** The tour reconstructs the story a pull request often arrives without: what behavior changed, the path from entry point to effect, and where it can fail. When the author pushes again, **Since your review** shows only what changed since your last checkpoint.
- **Free, open source, and local.** No Wingdiff account, seat license, or per-review fee, and no review service holding a copy of your code. Wingdiff runs on loopback and uses your existing Codex sign-in or your own OpenAI or Anthropic key, so your organization's model and data policies still apply.
- **Read-only by design.** Wingdiff fetches pull requests through the GitHub CLI into private Git refs. It never checks out the pull request, touches your working tree, or runs pull-request code.

### Wingdiff and automated reviewers

| | Hosted AI reviewers | Wingdiff |
|---|---|---|
| Who reviews | A bot that posts its own comments | You, with AI as a guide |
| What lands on the pull request | Bot comments, often on every push | One review you wrote and chose to publish |
| What you get | A list of findings | A tour ordered by behavior and risk, each claim linked to its evidence |
| Where your code goes | The review vendor's service | Your machine and the model provider you already use |
| Cost | Per seat or per review | Free; you bring your own model access |

Wingdiff can sit alongside an automated reviewer. Let the bot catch mechanical issues, and use Wingdiff to understand the change you are about to approve.

## What a review looks like

1. **Summary.** What changed in the system, how large the change is, and the findings worth your attention.
2. **Tour.** A sequence of semantic stops, each with the smallest useful slice of diff evidence. Flag a stop, select lines, or draft a comment as you go.
3. **Investigate.** Ask about the evidence in front of you. Wingdiff answers from the pinned base and head source, not from whatever the browser sends.
4. **Conclude.** The review desk shows your coverage, summary, inline comments, and disposition exactly as they will be published.

Browse mode shows the full diff at any time. Review progress, investigation notes, comments, and the publish receipt are stored on your machine. Run `npx wingdiff demo` to try the complete loop on a realistic fixture; the demo simulates publishing and uses clearly labeled sample answers when no model provider is configured.

## Get started

### Prerequisites

- [Git](https://git-scm.com/downloads)
- [Node.js](https://nodejs.org/) 22.13+ (excluding Node 23) or Node.js 24+ when using the npm package
- [GitHub CLI](https://cli.github.com/) authenticated with `gh auth login` for real pull requests
- [Codex](https://developers.openai.com/learn/codex) CLI authenticated with `codex login` for the default model transport, or an optional direct provider API key

Wingdiff supports macOS, Linux, and Windows. Its server binds to loopback by
default and is not intended to be deployed as a public web service.

### Quick start

```bash
npx wingdiff https://github.com/owner/repository/pull/123
```

Wingdiff starts on a loopback address and opens an authenticated local URL. It
uses the current checkout when it matches the pull request, or creates a private
bare repository cache when it does not. Inside a matching checkout, a pull
request number is enough:

```bash
npx wingdiff 123
npx wingdiff demo
```

The default npm release is the supported stable channel. Preview releases, when
available, use `npx wingdiff@next`.

Install the command permanently if you use it regularly:

```bash
npm install --global wingdiff
wingdiff 123
```

Run `wingdiff` with no arguments to open the pull request associated with the
current branch, or open the launcher when the branch has no pull request. Run
`wingdiff doctor` for actionable GitHub and model-provider setup checks.

### Run from source

Contributors and source-build users can run the same command surface locally:

```bash
git clone https://github.com/HartBrook/wingdiff.git
cd wingdiff
npm ci
npm run wingdiff -- --demo
```

Pass the checkout that owns the pull request when launching from the Wingdiff
source directory:

```bash
npm run wingdiff -- --checkout /path/to/repository https://github.com/owner/repository/pull/123
```

`--checkout` is an advanced override and may be relative to the directory where
you invoked npm. If you launch the source package from inside the target
checkout, npm's original working directory is used automatically:

```bash
cd /path/to/repository
npm --prefix /path/to/wingdiff run wingdiff -- https://github.com/owner/repository/pull/123
```

Use `npm run dev` when developing the UI without automatic browser launch.

## How it works

### Read-only PR acquisition

For a real pull request, use an authenticated GitHub CLI:

```bash
gh auth status
npx wingdiff https://github.com/owner/repository/pull/123
```

Wingdiff reads metadata through `gh`, fetches missing objects into private `refs/wingdiff/pull/...` references, and builds the full PR diff from the exact pinned merge-base/head pair GitHub compares. When no matching checkout is available, it keeps a private bare repository cache beside its application data. Update reviews use the exact reviewed-head/current-head pair. It does not checkout the PR, modify the worktree or index, or execute pull-request code. Acquired metadata, evidence, generated tours, and review checkpoints are stored in a local SQLite database. Set `WINGDIFF_DATA_DIR` to choose its location.

From the real-PR Summary, choose a configured model and select **Generate guided review**. The model organizes the validated diff into semantic stops, ranks concrete findings by severity, and references opaque evidence anchors. Wingdiff rejects the result unless every changed file is covered and every claim or finding resolves to an exact known anchor. Generated tours are pinned to the acquired head SHA and can be resumed locally.

Before generation, Wingdiff shows the exact model context, provider transport, changed files, repository instructions, exclusions, size, and content fingerprint. The immutable manifest, fingerprint, and evidence-anchor snapshot are stored with the tour; a changed manifest invalidates the resumable tour. Model-facing evidence references use compact request-local aliases constrained to the supplied anchor set, then map back to immutable evidence fingerprints before validation and storage. Potentially sensitive, generated, and vendor files are marked; common key and environment-file patterns are excluded by default. Exclusions are editable local globs. `AGENTS.md`, `CONTRIBUTING.md`, and `.github/CONTRIBUTING.md` are included when present, capped at 20,000 characters each. Context over 750,000 characters is blocked until reduced.

Guided-tour generation runs as a local background job. The browser polls its
status once per second, shows elapsed time and the configured deadline, and can
reconnect to an in-progress generation after a page refresh.

Investigation requests identify a persisted session and stop rather than sending authoritative evidence from the browser. The server reconstructs the stop, adds bounded base/head source windows and related symbol references from the pinned Git objects, and sends that grounded context to the selected provider.

Comments drafted from a real tour are also pinned to the acquired diff. Wingdiff records the GitHub side and exact line range, verifies the terminal line fingerprint against the canonical pull-request diff, and stores accepted drafts in the local SQLite session. A stale, cross-hunk, wrong-side, or non-diff anchor is rejected before it can enter the review queue.

The real-PR **Review desk** presents the exact summary, disposition, and inline-comment batch before an explicit publish action. Approval with unseen stops, flags, high-severity findings, or failed checks requires explicit acknowledgement. Immediately before publishing, Wingdiff rereads the pull request through the authenticated GitHub CLI, blocks a moved or closed head, and revalidates every stored anchor. It reserves the pinned head, then sends one batch review using `commit_id`, `line`, `side`, and optional multi-line coordinates. A successful GitHub receipt is saved locally. Concurrent publication is blocked, and an interrupted or ambiguous request must be reconciled against GitHub before the reviewer can enable a retry. The authenticated GitHub identity needs pull-request write permission to publish.

### Review author updates

After visiting every stop, select **Complete review** to create an explicit checkpoint at the current head SHA. **Check for updates** then reacquires the pull request without checking it out or running its code. If the author pushed a new head, Wingdiff opens a new local session in **Since your review** mode using the exact reviewed-head → current-head diff.

The **Entire PR** scope remains available as an independent backstop. Update and full-PR tours, progress, positions, and completion checkpoints are persisted separately. Previously reviewed areas that do not intersect the update are labeled as reviewed and unchanged. Every acquired revision is retained under a private `refs/wingdiff/pull/.../revisions/...` reference so a later force-push does not erase the comparison baseline.

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

Codex CLI uses the default model selected for the signed-in ChatGPT account. Wingdiff does not pass an API model ID to Codex, because API availability and ChatGPT-plan availability can differ. Codex CLI reviews offer low, medium, or high reasoning effort; if the account's default model does not accept the chosen effort, Codex reports the error and Wingdiff shows it. Named models are available through the direct OpenAI API provider:

- `gpt-6-sol` — default balance of review quality, speed, and cost
- `gpt-6-astra` — highest-capability option for difficult reviews
- `gpt-6-luna` — fast, cost-efficient investigations
- `gpt-5.3-codex` — deprecated Codex-tuned model available only through the direct OpenAI API provider

Claude Sonnet 4.6 and Opus 4.6 remain available through the same provider interface. Select Codex CLI, OpenAI API, or Anthropic API plus the model and supported reasoning effort from the model control in the top bar.

API keys are read only by the loopback Node server and are never returned to browser JavaScript. OpenAI API requests use the Responses API with `store: false`; tour generation uses strict structured output and investigations stream. Wingdiff never reads or copies Codex CLI credentials.

The local server generates a fresh launch token, exchanges it for an HTTP-only, same-site cookie, rejects cross-origin mutations, and refuses non-loopback binding unless `WINGDIFF_UNSAFE_ALLOW_REMOTE=1` is explicitly set. Server discovery files are private to the current OS user and are reused only for the same working directory.

### Configuration

All configuration is optional and is read only by the local Node process.
Shell environment variables take precedence. Installed copies also read a
user-owned `config.env` file from the platform configuration directory:

- macOS: `~/Library/Application Support/wingdiff/config.env`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/wingdiff/config.env`
- Windows: `%APPDATA%\\wingdiff\\config.env`

Set `WINGDIFF_CONFIG` to use another file. Run `wingdiff doctor` to print the
resolved path. Source checkouts continue to support the repository-root `.env`.

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Enable direct OpenAI API access |
| `ANTHROPIC_API_KEY` | Enable direct Anthropic API access |
| `WINGDIFF_CODEX_BIN` | Override the Codex CLI executable |
| `WINGDIFF_CODEX_TOUR_TIMEOUT_MS` | Override the Codex guided-tour timeout (default: 10 minutes) |
| `WINGDIFF_CODEX_INVESTIGATION_TIMEOUT_MS` | Override the Codex investigation timeout (default: 3 minutes) |
| `WINGDIFF_CODEX_TIMEOUT_MS` | Legacy override applied to both Codex request types |
| `WINGDIFF_DATA_DIR` | Choose the directory containing `wingdiff.sqlite3` |
| `WINGDIFF_CONFIG` | Read configuration from a specific environment file |
| `WINGDIFF_HOST` | Override the loopback host |
| `WINGDIFF_PORT` | Override the local port |
| `WINGDIFF_UNSAFE_ALLOW_REMOTE` | Allow a non-loopback host when set to `1`; unsupported and dangerous |

See [`.env.example`](./.env.example) for an annotated template. Never commit
provider keys or expose Wingdiff directly to an untrusted network.

## Verify

```bash
npm test
npm run typecheck
npm run build
npx playwright install chromium # once per machine
npm run test:e2e
```

The tests enforce the product's grounding contract: claims must resolve to real evidence, generated tours must cover every included changed file, diff ranges must be internally consistent, revision coverage must partition the full fixture tour, findings must remain attached to known stops, and staged comments must match the pinned GitHub diff side and line fingerprint. The browser suite drives a mocked real-PR session through context approval, generation, investigation, visible-code comment drafting, persistence, and navigation home.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `j` / `k` | Next / previous tour stop, or changed file in Browse mode |
| `a` | Investigate the active evidence |
| `c` | Draft a comment |
| `f` | Flag the current stop |
| `d` | Toggle tour and Browse mode |
| `r` | Open the review desk |
| `Escape` | Close the active overlay, otherwise return to the summary |

The open view, tour stop, and file live in the URL, so browser Back and Forward move within the review and a reload returns to the same place. Stepping between stops or files does not add history entries: one Back returns to wherever you opened them from.

## Contributing and support

Contributions are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) before
opening a pull request, use [GitHub Discussions](https://github.com/HartBrook/wingdiff/discussions)
for questions and ideas, and use [GitHub Issues](https://github.com/HartBrook/wingdiff/issues)
for reproducible defects.

Please report vulnerabilities privately according to [SECURITY.md](./SECURITY.md)
and follow the [Code of Conduct](./CODE_OF_CONDUCT.md) in all project spaces.

## License

Wingdiff is available under the [MIT License](./LICENSE).
