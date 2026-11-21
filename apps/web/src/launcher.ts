export interface PullRequestTarget {
  platform: "github" | "gitlab";
  host: string;
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
      status: "matched" | "managed" | "different" | "not-found";
      path?: string;
      repository?: string;
    };
    hostingCli: {
      provider: "github" | "gitlab";
      command: "gh" | "glab";
      installed: boolean;
      supported: boolean;
      version?: string;
      authenticated: boolean;
    };
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
  if (!response.ok || !body.target || !body.environment) throw new Error(body.error ?? "Wingdiff could not read that review target.");
  return { target: body.target, environment: body.environment };
}

export function acquisitionBlocker(preparation: TargetPreparation): string | undefined {
  const { hostingCli } = preparation.environment;
  const hostName = preparation.target.platform === "gitlab" ? "GitLab" : "GitHub";
  if (!hostingCli.installed) return `Install the ${hostName} CLI (${hostingCli.command}), then run: ${hostingCli.command} auth login`;
  if (!hostingCli.supported) return `GitLab CLI 1.100.0 or later is required.${hostingCli.version ? ` Found ${hostingCli.version}.` : ""} Upgrade glab and try again.`;
  if (!hostingCli.authenticated) return `${hostName} CLI is not authenticated. Run: ${hostingCli.command} auth login${preparation.target.host === "github.com" || preparation.target.host === "gitlab.com" ? "" : ` --hostname ${preparation.target.host}`}`;
  return undefined;
}

export function addRecentTarget(recent: PullRequestTarget[], target: PullRequestTarget, limit = 5): PullRequestTarget[] {
  return [target, ...recent.filter((candidate) => candidate.canonicalUrl !== target.canonicalUrl)].slice(0, limit);
}
