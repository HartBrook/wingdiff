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
  session?: string;
}

export interface TargetPreparation {
  target: PullRequestTarget;
  environment: {
    checkout: {
      status: "matched" | "different" | "not-found";
      path?: string;
      repository?: string;
    };
    githubCli: { installed: boolean };
    networkChecked: false;
  };
}

export function parseLaunchRoute(search: string): LaunchRoute {
  const parameters = new URLSearchParams(search);
  const target = parameters.get("target")?.trim();
  const session = parameters.get("session")?.trim();
  return {
    demo: parameters.get("demo") === "1",
    ...(target ? { target } : {}),
    ...(session ? { session } : {}),
  };
}

export async function preparePullRequestTarget(input: string, signal?: AbortSignal): Promise<TargetPreparation> {
  const response = await fetch("/api/targets/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
    signal,
  });
  const body = await response.json() as Partial<TargetPreparation> & { error?: string };
  if (!response.ok || !body.target || !body.environment) throw new Error(body.error ?? "Wingdiff could not read that pull request target.");
  return { target: body.target, environment: body.environment };
}

export function addRecentTarget(recent: PullRequestTarget[], target: PullRequestTarget, limit = 5): PullRequestTarget[] {
  return [target, ...recent.filter((candidate) => candidate.canonicalUrl !== target.canonicalUrl)].slice(0, limit);
}
