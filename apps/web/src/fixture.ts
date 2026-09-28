import type {
  PullRequestFixture,
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
  headSha: "a7c93e1",
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
    level: "high",
    detail: "Read-then-write counter updates may lose attempts under concurrent requests.",
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
    level: "medium",
    detail: "Sequential cases are covered; concurrent attempts and clock skew are not.",
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
    title: "The Redis counter update is not atomic",
    summary:
      "The new store reads the counter, increments it in application code, then writes it back with a TTL.",
    why:
      "Concurrent login attempts can observe the same count and overwrite each other. That weakens the control precisely when an attacker sends requests in parallel.",
    confidence: "high",
    minutes: 3,
    topologyNodes: ["policy", "store"],
    claims: [
      {
        id: "race-fact",
        text: "`get` and `set` execute as separate Redis operations with an application-side increment.",
        kind: "fact",
        confidence: "high",
        evidenceIds: ["redis-increment"],
      },
      {
        id: "race-impact",
        text: "Two concurrent failures can both persist the same next value, losing one attempt.",
        kind: "inference",
        confidence: "high",
        evidenceIds: ["redis-increment"],
      },
    ],
    prompts: [
      "Can this use INCR plus a conditional EXPIRE, or a small Lua script?",
      "Does the Redis client already expose a transaction helper used elsewhere?",
    ],
    finding: {
      id: "finding-race",
      title: "Counter updates can lose concurrent failures",
      body: "The read-modify-write sequence is vulnerable to lost updates, allowing parallel attempts to advance the throttle more slowly than intended.",
      severity: "high",
      category: "Concurrency",
      evidenceId: "redis-increment",
      suggestedComment:
        "Could we make this increment atomic? With separate `get` and `set` calls, concurrent failures can read the same value and overwrite one another, which weakens throttling under parallel attempts. `INCR` with a conditional TTL (or a Lua script) would preserve every failure.",
    },
    evidence: [
      {
        id: "redis-increment",
        path: "src/infra/redis/attempt-store.ts",
        label: "Counter persistence",
        language: "TypeScript",
        startLine: 22,
        endLine: 30,
        lines: [
          { kind: "header", content: "@@ -0,0 +22,9 @@ export class RedisAttemptStore {" },
          { kind: "addition", newLine: 22, content: "+ async increment(subject: string, ttlMs: number) {" },
          { kind: "addition", newLine: 23, content: "+   const key = this.key(subject);", emphasized: true },
          { kind: "addition", newLine: 24, content: "+   const current = Number(await this.redis.get(key) ?? 0);", emphasized: true },
          { kind: "addition", newLine: 25, content: "+   const next = current + 1;", emphasized: true },
          { kind: "addition", newLine: 26, content: "+   await this.redis.set(key, next, { px: ttlMs });", emphasized: true },
          { kind: "addition", newLine: 27, content: "+   return next;" },
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
    title: "Tests prove the sequence, but not the adversarial case",
    summary:
      "The suite covers progressive delays, successful reset, and the response shape using sequential requests and a fake clock.",
    why:
      "The tests specify the intended policy well, but they would remain green if concurrent requests lost counter updates or if the real Redis TTL behaved differently from the fake.",
    confidence: "high",
    minutes: 3,
    topologyNodes: ["tests", "login", "policy", "store"],
    claims: [
      {
        id: "sequential-only",
        text: "All failure attempts in the new tests are awaited serially.",
        kind: "fact",
        confidence: "high",
        evidenceIds: ["login-tests"],
      },
      {
        id: "missing-integration",
        text: "No added test exercises the real Redis implementation or concurrent increments.",
        kind: "fact",
        confidence: "high",
        evidenceIds: ["login-tests"],
      },
    ],
    prompts: [
      "Would a focused store integration test catch the atomicity and TTL behavior cheaply?",
      "Should the test pin exact boundary behavior at the third and fifth failures?",
    ],
    finding: {
      id: "finding-test",
      title: "The concurrency behavior is untested",
      body: "Sequential handler tests cannot expose lost updates in the Redis store.",
      severity: "medium",
      category: "Testing",
      evidenceId: "login-tests",
      suggestedComment:
        "Could we add a store-level test that increments the same subject concurrently and verifies no attempts are lost? The sequential handler cases define the delay policy nicely, but they would not catch a read-modify-write race in the Redis adapter.",
    },
    evidence: [
      {
        id: "login-tests",
        path: "tests/auth/login.test.ts",
        label: "Progressive delay coverage",
        language: "TypeScript",
        startLine: 112,
        endLine: 128,
        lines: [
          { kind: "header", content: "@@ -98,6 +112,17 @@ describe(\"login throttling\", () => {" },
          { kind: "addition", newLine: 112, content: "+ it(\"increases delay after repeated failures\", async () => {" },
          { kind: "addition", newLine: 113, content: "+   await failLogin(\"maya@example.com\");", emphasized: true },
          { kind: "addition", newLine: 114, content: "+   await failLogin(\"maya@example.com\");", emphasized: true },
          { kind: "addition", newLine: 115, content: "+   await failLogin(\"maya@example.com\");", emphasized: true },
          { kind: "addition", newLine: 117, content: "+   const response = await failLogin(\"maya@example.com\");" },
          { kind: "addition", newLine: 118, content: "+   expect(response.status).toBe(429);" },
          { kind: "addition", newLine: 119, content: "+   expect(response.headers[\"retry-after\"]).toBe(\"1\");" },
          { kind: "addition", newLine: 120, content: "+ });" },
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
    "Yes. Two requests can both read `4`, both compute `5`, and both write `5`. Redis `INCR` is atomic. Preserving the TTL usually needs either `INCR` plus conditional expiry in a transaction, or a Lua script that increments and sets expiry only for a new key.",
  "error-contract":
    "The `Retry-After` value uses the standards-compatible delay-seconds form and rounds up, so clients never retry early because of truncation. The compatibility uncertainty is in client handling of the new 429 status, which is not visible in this repository.",
  "coverage-gap":
    "A useful regression test would issue 20 `increment()` calls for one subject with `Promise.all`, then assert the stored count is 20 and the TTL remains present. Run it against the real Redis adapter or a faithful test container; an in-memory mock may serialize away the race.",
};

