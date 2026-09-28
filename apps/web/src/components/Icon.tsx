import type { SVGProps } from "react";

export type IconName =
  | "arrow-left"
  | "arrow-right"
  | "check"
  | "chevron-right"
  | "code"
  | "command"
  | "comment"
  | "external"
  | "eye"
  | "flag"
  | "git-pull"
  | "layers"
  | "menu"
  | "moon"
  | "question"
  | "route"
  | "search"
  | "shield"
  | "spark"
  | "sun"
  | "x";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {iconPaths[name]}
    </svg>
  );
}

const common = {
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  strokeWidth: 1.8,
};

const iconPaths: Record<IconName, React.ReactNode> = {
  "arrow-left": <><path {...common} d="m15 18-6-6 6-6" /><path {...common} d="M9 12h11" /></>,
  "arrow-right": <><path {...common} d="m9 18 6-6-6-6" /><path {...common} d="M4 12h11" /></>,
  check: <path {...common} d="m5 12 4 4L19 6" />,
  "chevron-right": <path {...common} d="m9 18 6-6-6-6" />,
  code: <path {...common} d="m8 9-3 3 3 3m8-6 3 3-3 3m-2-9-4 12" />,
  command: <><path {...common} d="M9 6v12M15 6v12M6 9h12M6 15h12" /><path {...common} d="M9 6a3 3 0 1 0-3 3m9-3a3 3 0 1 1 3 3m-9 9a3 3 0 1 1-3-3m9 3a3 3 0 1 0 3-3" /></>,
  comment: <path {...common} d="M20 15a3 3 0 0 1-3 3H9l-5 3v-6a3 3 0 0 1-1-2V7a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3Z" />,
  external: <><path {...common} d="M14 4h6v6m0-6-9 9" /><path {...common} d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></>,
  eye: <><path {...common} d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle {...common} cx="12" cy="12" r="2.5" /></>,
  flag: <><path {...common} d="M5 21V4" /><path {...common} d="M5 5h10l-1 3 3 3H5" /></>,
  "git-pull": <><circle {...common} cx="6" cy="5" r="2" /><circle {...common} cx="18" cy="19" r="2" /><path {...common} d="M6 7v10m12 0V9a4 4 0 0 0-4-4h-3m0 0 3-3m-3 3 3 3" /></>,
  layers: <><path {...common} d="m12 2 9 5-9 5-9-5 9-5Z" /><path {...common} d="m3 12 9 5 9-5M3 17l9 5 9-5" /></>,
  menu: <><path {...common} d="M4 7h16M4 12h16M4 17h16" /></>,
  moon: <path {...common} d="M20.5 14.2A8 8 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z" />,
  question: <><circle {...common} cx="12" cy="12" r="9" /><path {...common} d="M9.6 9a2.5 2.5 0 1 1 3.6 2.25c-.8.4-1.2.9-1.2 1.75m0 4h.01" /></>,
  route: <><circle {...common} cx="6" cy="5" r="2" /><circle {...common} cx="18" cy="19" r="2" /><path {...common} d="M8 5h4a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h7" /></>,
  search: <><circle {...common} cx="11" cy="11" r="7" /><path {...common} d="m20 20-4-4" /></>,
  shield: <path {...common} d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z" />,
  spark: <path {...common} d="m12 2 1.7 5.3L19 9l-5.3 1.7L12 16l-1.7-5.3L5 9l5.3-1.7L12 2Zm7 13 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" />,
  sun: <><circle {...common} cx="12" cy="12" r="4" /><path {...common} d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  x: <path {...common} d="m6 6 12 12M18 6 6 18" />,
};

