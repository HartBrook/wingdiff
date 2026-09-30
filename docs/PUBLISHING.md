# Public repository checklist

This checklist is for maintainers changing Wingdiff from private to public.
Repository visibility is not changed by the project scripts or workflows.

## Publish the npm package

The `wingdiff` name is configured as the public package in the repository root.
While the GitHub repository is private, releases publish the public npm package
under the `next` tag using the granular npm token stored in the `NPM_TOKEN`
repository secret. Provenance is intentionally disabled because npm cannot
generate provenance for a package built from a private repository. The package
tarball is public even though the GitHub repository is private, so inspect it
before releasing; it contains the compiled server and browser application,
source maps, README, and license.

1. Update the version in `package.json` and `package-lock.json`.
2. Run the **Publish npm package** workflow in dry-run mode and inspect its
   package-content output.
3. Create a GitHub release tagged `v<version>` from the intended commit.
4. Confirm the workflow tests, builds, and publishes the package under `next`.
5. Test `npx wingdiff@next --version` from a clean temporary directory.

The release job rejects a tag that does not exactly match `package.json`. Do
not publish from a developer checkout; release publication belongs to the
audited GitHub Actions workflow. The verified `0.2.1` corrective release is the
fixed `latest` baseline; subsequent prototype releases advance only `next`.

When the repository becomes public, configure the package's npm trusted
publisher for this workflow, remove `NPM_TOKEN`, grant `id-token: write`, and
publish with `--provenance`. When a release is ready to become the default npm
version, promote it without rebuilding:

```bash
npm dist-tag add wingdiff@1.0.0 latest
```

## Before changing visibility

- Confirm every contributor intends their name and commit email to become
  public. Rewrite unintended personal addresses before publication; `.mailmap`
  changes display only and does not remove metadata from Git objects.
- Run a full-history secret scan. The `Secret scan` workflow protects future
  changes, but it does not replace a pre-publication history audit.
- Review every tracked file and GitHub release artifact for private source,
  tokens, internal URLs, customer names, and proprietary planning material.
- Confirm the copyright holder and MIT licensing statement are correct.
- Commit and push the community files and workflows on a private branch first.

## Change visibility

Use **Settings → General → Danger Zone → Change repository visibility**. Read
GitHub's warning carefully and confirm that forks, Actions logs, releases,
issues, discussions, and the entire reachable Git history are suitable for
public access.

## Immediately after publication

1. Enable private vulnerability reporting under **Settings → Security → Code
   security and analysis**.
2. Let the workflows complete successfully on `main`.
3. Protect `main` under **Settings → Branches**. Require a pull request, one
   approval, CODEOWNER review, resolved conversations, linear history, and the
   CI, end-to-end, dependency-review, CodeQL, and Gitleaks checks. Disable force
   pushes and branch deletion.
4. Upload `docs/images/social-preview.png` under **Settings → General → Social
   preview**.
5. Confirm dependency alerts, Dependabot security updates, Discussions, issue
   forms, topics, and the security-advisory link are visible and working.
6. Open the README from a logged-out browser and follow the quick start from a
   clean checkout.

GitHub does not expose every item above to private repositories on the free
plan, so branch protection and private vulnerability reporting may need to be
configured immediately after the visibility change.
