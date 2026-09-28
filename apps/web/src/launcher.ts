export interface PullRequestTarget {
  owner: string;
  repository: string;
  number: number;
  canonicalUrl: string;
  label: string;
  source: "url" | "shorthand" | "checkout";
}

export interface LaunchRoute {
  demo: boolean;
  target?: string;
}

export function parseLaunchRoute(search: string): LaunchRoute {
  const parameters = new URLSearchParams(search);
  const target = parameters.get("target")?.trim();
  return {
    demo: parameters.get("demo") === "1",
    ...(target ? { target } : {}),
  };
}

export async function normalizePullRequestTarget(input: string, signal?: AbortSignal): Promise<PullRequestTarget> {
  const response = await fetch("/api/targets/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
    signal,
  });
  const body = await response.json() as { target?: PullRequestTarget; error?: string };
  if (!response.ok || !body.target) throw new Error(body.error ?? "Wingdiff could not read that pull request target.");
  return body.target;
}

export function addRecentTarget(recent: PullRequestTarget[], target: PullRequestTarget, limit = 5): PullRequestTarget[] {
  return [target, ...recent.filter((candidate) => candidate.canonicalUrl !== target.canonicalUrl)].slice(0, limit);
}
