# Security policy

## Supported versions

Wingdiff is pre-1.0 software. Security fixes are applied to the latest release
and the `main` branch; older releases may not receive backports.

| Version | Supported |
|---|---|
| `main` | Yes |
| `0.2.x` | Yes |
| `< 0.2` | No |

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability reporting](https://github.com/HartBrook/wingdiff/security/advisories/new)
to share the affected version, impact, reproduction steps, and any suggested
mitigation. The maintainer will acknowledge the report, investigate it, and
coordinate disclosure and a fix when warranted.

If private vulnerability reporting is temporarily unavailable, do not disclose
the report publicly. Wait for the confidential channel to be restored.

## Security model

Wingdiff is designed to bind only to a loopback interface. It reads source and
GitHub metadata from a checkout the user already controls, stores review state
locally, and sends only the context shown in its approval screen to the chosen
model provider. Publishing a review is an explicit GitHub write.

Treat `WINGDIFF_UNSAFE_ALLOW_REMOTE=1` as an unsupported escape hatch, not a
deployment mode. Never expose Wingdiff directly to an untrusted network.

Reports about unsupported public-network deployment, a compromised local
machine, or provider behavior outside Wingdiff's documented controls may be
closed as out of scope, but reports showing that Wingdiff violates its stated
local security boundary are in scope.
