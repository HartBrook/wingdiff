import type {
  PullRequestFixture,
  ReviewUpdateFixture,
  Risk,
  TopologyEdge,
  TopologyNode,
  TourStop,
} from "./types";

export const pullRequest: PullRequestFixture = {
  number: 842,
  repository: "northstar/api",
  title: "Introduce progressive login throttling",
  author: "maya-chen",
  authorInitials: "MC",
  branch: "maya/progressive-throttle",
  base: "main",
  headSha: "b91e204",
  additions: 214,
  deletions: 47,
  filesChanged: 8,
  commits: 4,
  checks: { passed: 18, total: 18 },
  statedIntent:
    "Slow repeated password attempts without revealing whether an account exists.",
  inferredSummary:
    "The login path now consults a Redis-backed attempt policy before password verification, records failures with escalating delays, and translates throttling into a typed HTTP response.",
  estimatedMinutes: 12,
};

export const risks: Risk[] = [
  {
    id: "risk-race",
    label: "Concurrency",
    level: "low",
    detail: "The atomic script fixes the earlier lost-update path; verify production client behavior.",
    stopId: "atomic-counter",
  },
  {
    id: "risk-availability",
    label: "Availability",
    level: "medium",
    detail: "Redis failure behavior decides whether authentication fails open or closed.",
    stopId: "request-gate",
  },
  {
    id: "risk-contract",
    label: "API contract",
    level: "medium",
    detail: "Clients receive a new 429 body and Retry-After header.",
    stopId: "error-contract",
  },
  {
    id: "risk-coverage",
    label: "Test coverage",
    level: "low",
    detail: "Concurrent increments are covered; TTL assertions may still be timing-sensitive.",
    stopId: "coverage-gap",
  },
];

export const topologyNodes: TopologyNode[] = [
  { id: "route", label: "POST /sessions", detail: "HTTP entry", kind: "entry", x: 56, y: 82 },
  { id: "login", label: "login()", detail: "orchestration", kind: "logic", x: 226, y: 82 },
  { id: "policy", label: "AttemptPolicy", detail: "delay rules", kind: "logic", x: 396, y: 82 },
  { id: "store", label: "RedisAttemptStore", detail: "shared state", kind: "boundary", x: 566, y: 32 },
  { id: "error", label: "RateLimitError", detail: "HTTP contract", kind: "contract", x: 566, y: 132 },
  { id: "tests", label: "login.test.ts", detail: "behavior spec", kind: "test", x: 396, y: 202 },
];

export const topologyEdges: TopologyEdge[] = [
  { from: "route", to: "login" },
  { from: "login", to: "policy", label: "check" },
  { from: "policy", to: "store", label: "read/write" },
  { from: "policy", to: "error", label: "deny" },
  { from: "tests", to: "login", label: "asserts" },
];

export const tourStops: TourStop[] = [
  {
    id: "request-gate",
    order: 1,
    eyebrow: "Entry point",
    title: "Every login now passes through a shared throttle gate",
    summary:
      "The handler computes an opaque subject key and asks the attempt policy for permission before doing any password work.",
    why:
      "This is the behavioral boundary for the entire feature. Its failure semantics determine both account-enumeration resistance and whether a Redis outage blocks all logins.",
    confidence: "high",
    minutes: 2,
    topologyNodes: ["route", "login", "policy"],
    claims: [
      {
        id: "gate-before-password",
        text: "Throttle evaluation happens before user lookup and password verification.",
        kind: "fact",
        confidence: "high",
        evidenceIds: ["login-gate"],
      },
      {
        id: "opaque-key",
        text: "Hashing the normalized email is intended to avoid storing raw identifiers in Redis.",
        kind: "inference",
        confidence: "medium",
        evidenceIds: ["login-gate"],
      },
    ],
    prompts: [
      "Should a Redis outage deny all login attempts or fall back to password verification?",
      "Is email normalization identical to the lookup path used by the user store?",
    ],
    evidence: [
      {
        id: "login-gate",
        path: "src/auth/login.ts",
        label: "Login orchestration",
        language: "TypeScript",
        startLine: 41,
        endLine: 58,
        lines: [
          { kind: "header", content: "@@ -41,8 +41,18 @@ export async function login(input: LoginInput) {" },
          { kind: "context", oldLine: 41, newLine: 41, content: "  const email = normalizeEmail(input.email);" },
          { kind: "addition", newLine: 42, content: "+ const subject = await opaqueKey(email);", emphasized: true },
          { kind: "addition", newLine: 43, content: "+ const decision = await attemptPolicy.check(subject);", emphasized: true },
          { kind: "addition", newLine: 44, content: "+ if (!decision.allowed) {", emphasized: true },
          { kind: "addition", newLine: 45, content: "+   throw new RateLimitError(decision.retryAfterMs);", emphasized: true },
          { kind: "addition", newLine: 46, content: "+ }", emphasized: true },
          { kind: "context", oldLine: 42, newLine: 48, content: "  const user = await users.findByEmail(email);" },
          { kind: "context", oldLine: 43, newLine: 49, content: "  const valid = user && await passwords.verify(input.password, user.hash);" },
          { kind: "addition", newLine: 51, content: "+ await attemptPolicy.record(subject, Boolean(valid));" },
          { kind: "context", oldLine: 44, newLine: 52, content: "  if (!valid) throw new InvalidCredentialsError();" },
        ],
      },
    ],
  },
  {
    id: "delay-policy",
    order: 2,
    eyebrow: "Core behavior",
    title: "Delay increases in bounded steps, then resets on success",
    summary:
      "The policy maps recent failures to four delay bands and clears the subject after a successful authentication.",
    why:
      "This is the product policy encoded in code. Review should verify that the thresholds, reset behavior, and inclusive boundaries match the intended security posture.",
    confidence: "high",
    minutes: 2,
    topologyNodes: ["policy"],
    claims: [
      {
        id: "delay-bands",
        text: "The first two failures are immediate; subsequent bands wait 1s, 5s, and at most 30s.",
        kind: "fact",
        confidence: "high",
        evidenceIds: ["policy-bands"],
      },
      {
        id: "success-reset",
        text: "A successful login fully removes accumulated failure state.",
        kind: "fact",
        confidence: "high",
        evidenceIds: ["policy-record"],
      },
    ],
    prompts: [
      "Are the threshold boundaries correct at exactly 3, 5, and 8 failures?",
      "Should a successful login erase the audit signal or only reset the active delay?",
    ],
    evidence: [
      {
        id: "policy-bands",
        path: "src/auth/attempt-policy.ts",
        label: "Delay calculation",
        language: "TypeScript",
        startLine: 18,
        endLine: 29,
        lines: [
          { kind: "header", content: "@@ -0,0 +18,12 @@ export class AttemptPolicy {" },
          { kind: "addition", newLine: 18, content: "+ private delayFor(failures: number): number {" },
          { kind: "addition", newLine: 19, content: "+   if (failures < 3) return 0;" },
          { kind: "addition", newLine: 20, content: "+   if (failures < 5) return seconds(1);" },
          { kind: "addition", newLine: 21, content: "+   if (failures < 8) return seconds(5);" },
          { kind: "addition", newLine: 22, content: "+   return seconds(30);" },
          { kind: "addition", newLine: 23, content: "+ }" },
        ],
      },
      {
        id: "policy-record",
        path: "src/auth/attempt-policy.ts",
        label: "Success and failure recording",
        language: "TypeScript",
        startLine: 31,
        endLine: 38,
        lines: [
          { kind: "header", content: "@@ -0,0 +31,8 @@ export class AttemptPolicy {" },
          { kind: "addition", newLine: 31, content: "+ async record(subject: string, success: boolean) {" },
          { kind: "addition", newLine: 32, content: "+   if (success) {" },
          { kind: "addition", newLine: 33, content: "+     return this.store.clear(subject);" },
          { kind: "addition", newLine: 34, content: "+   }" },
          { kind: "addition", newLine: 36, content: "+   return this.store.increment(subject, this.windowMs);" },
          { kind: "addition", newLine: 37, content: "+ }" },
        ],
      },
    ],
  },
  {
    id: "atomic-counter",
    order: 3,
    eyebrow: "State boundary",
    title: "Redis counter updates now execute atomically",
    summary:
      "The store uses one Lua script to increment the counter and apply its TTL without an application-side read-modify-write.",
    why:
      "This boundary controls whether parallel login attempts can lose failure counts.",
    confidence: "high",
    minutes: 3,
    topologyNodes: ["policy", "store"],
    claims: [
      {
        id: "race-fact",
        text: "Increment and first-write expiry happen inside one Redis script.",
        kind: "fact",
        confidence: "high",
        evidenceIds: ["redis-increment"],
      },
      {
        id: "race-impact",
        text: "The previous lost-update path is no longer present.",
        kind: "inference",
        confidence: "high",
        evidenceIds: ["redis-increment"],
      },
    ],
    prompts: [
      "Does the production Redis client return the script result consistently as a number or string?",
      "Is the key strategy compatible with Redis Cluster script routing?",
    ],
    evidence: [
      {
        id: "redis-increment",
        path: "src/infra/redis/attempt-store.ts",
        label: "Counter persistence",
        language: "TypeScript",
        startLine: 12,
        endLine: 30,
        lines: [
          { kind: "header", content: "@@ -0,0 +12,19 @@ export class RedisAttemptStore {" },
          { kind: "addition", newLine: 12, content: "+ const INCREMENT_WITH_TTL = `" },
          { kind: "addition", newLine: 13, content: "+   local next = redis.call('INCR', KEYS[1])", emphasized: true },
          { kind: "addition", newLine: 14, content: "+   if next == 1 then" },
          { kind: "addition", newLine: 15, content: "+     redis.call('PEXPIRE', KEYS[1], ARGV[1])", emphasized: true },
          { kind: "addition", newLine: 16, content: "+   end" },
          { kind: "addition", newLine: 17, content: "+   return next" },
          { kind: "addition", newLine: 18, content: "+ `;" },
          { kind: "addition", newLine: 22, content: "+ async increment(subject: string, ttlMs: number) {" },
          { kind: "addition", newLine: 23, content: "+   const next = await this.redis.eval(INCREMENT_WITH_TTL, {" },
          { kind: "addition", newLine: 24, content: "+     keys: [this.key(subject)]," },
          { kind: "addition", newLine: 25, content: "+     arguments: [String(ttlMs)]," },
          { kind: "addition", newLine: 26, content: "+   });" },
          { kind: "addition", newLine: 27, content: "+   return Number(next);" },
          { kind: "addition", newLine: 28, content: "+ }" },
        ],
      },
    ],
  },
  {
    id: "error-contract",
    order: 4,
    eyebrow: "External contract",
    title: "Throttled requests gain a typed 429 response",
    summary:
      "A new error mapper returns a stable code and Retry-After header while keeping credential failures indistinguishable.",
    why:
      "This is a public API behavior change. Clients may branch on the status, error code, or header units, so the contract deserves direct review beyond the internal policy.",
    confidence: "high",
    minutes: 2,
    topologyNodes: ["login", "error"],
    claims: [
      {
        id: "retry-header",
        text: "Retry-After is rounded up to whole seconds, as required for the delay-seconds form.",
        kind: "fact",
        confidence: "high",
        evidenceIds: ["error-mapper"],
      },
      {
        id: "client-assumption",
        text: "Existing clients may currently treat all login failures as 401 responses.",
        kind: "unknown",
        confidence: "low",
        evidenceIds: ["error-mapper"],
      },
    ],
    prompts: [
      "Have mobile and web clients been checked for status-specific login handling?",
      "Do API docs and observability dashboards recognize AUTH_THROTTLED?",
    ],
    evidence: [
      {
        id: "error-mapper",
        path: "src/http/error-response.ts",
        label: "Public error response",
        language: "TypeScript",
        startLine: 64,
        endLine: 75,
        lines: [
          { kind: "header", content: "@@ -64,6 +64,12 @@ export function errorResponse(error: Error) {" },
          { kind: "addition", newLine: 64, content: "+ if (error instanceof RateLimitError) {" },
          { kind: "addition", newLine: 65, content: "+   return {" },
          { kind: "addition", newLine: 66, content: "+     status: 429," },
          { kind: "addition", newLine: 67, content: "+     headers: { " + '"Retry-After": String(Math.ceil(error.retryAfterMs / 1000)) },' },
          { kind: "addition", newLine: 68, content: "+     body: { code: " + '"AUTH_THROTTLED", message: "Try again later" },' },
          { kind: "addition", newLine: 69, content: "+   };" },
          { kind: "addition", newLine: 70, content: "+ }" },
          { kind: "context", oldLine: 64, newLine: 72, content: "  if (error instanceof InvalidCredentialsError) {" },
          { kind: "context", oldLine: 65, newLine: 73, content: "    return { status: 401, body: { code: \"INVALID_CREDENTIALS\" } };" },
        ],
      },
    ],
  },
  {
    id: "coverage-gap",
    order: 5,
    eyebrow: "Verification",
    title: "The Redis adapter now has concurrent coverage",
    summary:
      "A store-level test sends concurrent increments for one subject and verifies the final count and TTL.",
    why:
      "This regression test directly exercises the failure mode raised in the previous review.",
    confidence: "high",
    minutes: 3,
    topologyNodes: ["tests", "login", "policy", "store"],
    claims: [
      {
        id: "sequential-only",
        text: "Twenty increments run concurrently against the same subject.",
        kind: "fact",
        confidence: "high",
        evidenceIds: ["login-tests"],
      },
      {
        id: "missing-integration",
        text: "The assertion verifies both the final counter value and a remaining TTL.",
        kind: "fact",
        confidence: "high",
        evidenceIds: ["login-tests"],
      },
    ],
    prompts: [
      "Does this test run against the same Redis behavior used in CI and production?",
      "Could the TTL assertion tolerate normal scheduling delay without becoming flaky?",
    ],
    evidence: [
      {
        id: "login-tests",
        path: "tests/infra/redis/attempt-store.test.ts",
        label: "Concurrent counter coverage",
        language: "TypeScript",
        startLine: 44,
        endLine: 56,
        lines: [
          { kind: "header", content: "@@ -0,0 +44,13 @@ describe(\"RedisAttemptStore\", () => {" },
          { kind: "addition", newLine: 44, content: "+ it(\"preserves concurrent increments and expiry\", async () => {" },
          { kind: "addition", newLine: 45, content: "+   const subject = \"subject-1\";" },
          { kind: "addition", newLine: 46, content: "+   await Promise.all(", emphasized: true },
          { kind: "addition", newLine: 47, content: "+     Array.from({ length: 20 }, () => store.increment(subject, 60_000)),", emphasized: true },
          { kind: "addition", newLine: 48, content: "+   );" },
          { kind: "addition", newLine: 50, content: "+   expect(await redis.get(keyFor(subject))).toBe(\"20\");", emphasized: true },
          { kind: "addition", newLine: 51, content: "+   expect(await redis.pTTL(keyFor(subject))).toBeGreaterThan(0);" },
          { kind: "addition", newLine: 52, content: "+ });" },
        ],
      },
    ],
  },
];

export const reviewUpdate: ReviewUpdateFixture = {
  fromHeadSha: "a7c93e1",
  toHeadSha: pullRequest.headSha,
  commits: 2,
  filesChanged: 2,
  additions: 38,
  deletions: 9,
  changedStopIds: ["atomic-counter", "coverage-gap"],
  unchangedStopIds: ["request-gate", "delay-policy", "error-contract"],
  findingRevisions: [
    {
      findingId: "finding-race",
      stopId: "atomic-counter",
      title: "Counter updates can lose concurrent failures",
      severity: "high",
      state: "appears-addressed",
      summary: "The follow-up replaces the application-side read and write with an atomic Redis script.",
    },
    {
      findingId: "finding-test",
      stopId: "coverage-gap",
      title: "The concurrency behavior is untested",
      severity: "medium",
      state: "appears-addressed",
      summary: "The follow-up adds concurrent coverage against the Redis adapter.",
    },
  ],
};

export const updateStops: TourStop[] = [
  {
    id: "atomic-counter",
    order: 1,
    eyebrow: "State boundary",
    title: "The counter fix moves the update into Redis",
    summary:
      "The follow-up replaces the read-modify-write sequence with one script that increments the counter and sets its first-write expiry.",
    why: "This is the direct response to the earlier concurrency finding.",
    confidence: "high",
    minutes: 2,
    topologyNodes: ["policy", "store"],
    claims: [
      {
        id: "update-atomic-operation",
        text: "The application no longer reads and rewrites the counter value.",
        kind: "fact",
        confidence: "high",
        evidenceIds: ["redis-increment-update"],
      },
      {
        id: "update-race-addressed",
        text: "The change appears to close the lost-update path raised in the previous review.",
        kind: "inference",
        confidence: "high",
        evidenceIds: ["redis-increment-update"],
      },
    ],
    prompts: [
      "Does the production Redis client return the script result consistently as a number or string?",
      "Is the key strategy compatible with Redis Cluster script routing?",
    ],
    evidence: [
      {
        id: "redis-increment-update",
        path: "src/infra/redis/attempt-store.ts",
        label: "Counter fix",
        language: "TypeScript",
        startLine: 22,
        endLine: 28,
        lines: [
          { kind: "header", content: "@@ -22,7 +22,7 @@ export class RedisAttemptStore {" },
          { kind: "deletion", oldLine: 22, content: "- const current = Number(await this.redis.get(key) ?? 0);", emphasized: true },
          { kind: "deletion", oldLine: 23, content: "- const next = current + 1;", emphasized: true },
          { kind: "deletion", oldLine: 24, content: "- await this.redis.set(key, String(next), { PX: ttlMs });", emphasized: true },
          { kind: "addition", newLine: 22, content: "+ const next = await this.redis.eval(INCREMENT_WITH_TTL, {", emphasized: true },
          { kind: "addition", newLine: 23, content: "+   keys: [this.key(subject)]," },
          { kind: "addition", newLine: 24, content: "+   arguments: [String(ttlMs)]," },
          { kind: "addition", newLine: 25, content: "+ });" },
          { kind: "addition", newLine: 26, content: "+ return Number(next);", emphasized: true },
        ],
      },
    ],
  },
  {
    id: "coverage-gap",
    order: 2,
    eyebrow: "Verification",
    title: "A concurrent regression test covers the fix",
    summary:
      "The new test sends twenty increments at once, then checks the stored count and expiry.",
    why: "This is the direct response to the earlier coverage finding.",
    confidence: "high",
    minutes: 2,
    topologyNodes: ["tests", "store"],
    claims: [
      {
        id: "update-concurrent-test",
        text: "Twenty writes target the same subject concurrently.",
        kind: "fact",
        confidence: "high",
        evidenceIds: ["concurrent-test-update"],
      },
      {
        id: "update-test-result",
        text: "The assertions cover the final count and the presence of a TTL.",
        kind: "fact",
        confidence: "high",
        evidenceIds: ["concurrent-test-update"],
      },
    ],
    prompts: [
      "Does this run against the same Redis behavior used in CI and production?",
      "Could the TTL assertion tolerate normal scheduling delay without becoming flaky?",
    ],
    evidence: [
      {
        id: "concurrent-test-update",
        path: "tests/infra/redis/attempt-store.test.ts",
        label: "Concurrent regression test",
        language: "TypeScript",
        startLine: 44,
        endLine: 52,
        lines: [
          { kind: "header", content: "@@ -0,0 +44,9 @@ describe(\"RedisAttemptStore\", () => {" },
          { kind: "addition", newLine: 44, content: "+ it(\"preserves concurrent increments and expiry\", async () => {" },
          { kind: "addition", newLine: 45, content: "+   const subject = \"subject-1\";" },
          { kind: "addition", newLine: 46, content: "+   await Promise.all(", emphasized: true },
          { kind: "addition", newLine: 47, content: "+     Array.from({ length: 20 }, () => store.increment(subject, 60_000)),", emphasized: true },
          { kind: "addition", newLine: 48, content: "+   );" },
          { kind: "addition", newLine: 50, content: "+   expect(await redis.get(keyFor(subject))).toBe(\"20\");", emphasized: true },
          { kind: "addition", newLine: 51, content: "+   expect(await redis.pTTL(keyFor(subject))).toBeGreaterThan(0);" },
          { kind: "addition", newLine: 52, content: "+ });" },
        ],
      },
    ],
  },
];

export const mockAnswers: Record<string, string> = {
  "request-gate":
    "The current path fails closed: `attemptPolicy.check()` is awaited without a recovery boundary, so a Redis error escapes before user lookup. That protects the throttle but makes Redis part of login availability. I would verify whether that matches the service’s existing dependency policy.",
  "delay-policy":
    "At the boundaries, failure counts 0–2 have no delay, 3–4 wait 1 second, 5–7 wait 5 seconds, and 8+ wait 30 seconds. The implementation is internally consistent; the open question is whether the count being checked includes the attempt currently in flight.",
  "atomic-counter":
    "The script removes the application-side lost-update window by keeping increment and first-write expiry inside Redis. I would still verify the client return type and cluster routing in the production configuration.",
  "error-contract":
    "The `Retry-After` value uses the standards-compatible delay-seconds form and rounds up, so clients never retry early because of truncation. The compatibility uncertainty is in client handling of the new 429 status, which is not visible in this repository.",
  "coverage-gap":
    "The parallel test directly exercises the earlier failure mode and checks both count and expiry. Its value depends on running against the real adapter or a faithful Redis test environment; the TTL assertion should also allow normal scheduling delay.",
};
