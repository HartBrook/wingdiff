# Release guide

This checklist describes how maintainers publish Wingdiff to npm.

## Prepare the release

1. Update the version in the root and workspace `package.json` files and in
   `package-lock.json`.
2. Run the full validation suite:

   ```bash
   npm test
   npm run typecheck
   npm run build
   npm run test:e2e
   npm run test:package
   ```

3. Run `npm pack --dry-run` and inspect the complete package-content list.
4. Confirm that the changelog or release notes describe user-visible changes
   and omit private repository data, credentials, and model output.

## Publish

Create a GitHub release tagged `v<version>` from the intended commit. Mark it
as a prerelease only when it should publish to the `next` channel. Stable
releases publish under `latest`.

The release workflow rejects a tag that does not exactly match `package.json`,
runs the test and build checks, inspects the package, verifies an installation
from the tarball, and then publishes to npm. Release publication belongs to the
audited GitHub Actions workflow rather than a developer checkout.

## Verify

After the workflow succeeds:

1. Confirm the expected tags with `npm view wingdiff dist-tags`.
2. Test `npx wingdiff --version` for a stable release or
   `npx wingdiff@next --version` for a prerelease from a clean temporary
   directory.
3. Confirm the GitHub release contains only the intended notes and artifacts.

If a preview is promoted without rebuilding, move the existing version to the
stable channel with an npm account that has tag-management permission:

```bash
npm dist-tag add wingdiff@<version> latest
```
