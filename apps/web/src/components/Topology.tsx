import { topologyEdges, topologyNodes } from "../fixture";

interface TopologyProps {
  activeIds?: string[];
  compact?: boolean;
}

export function Topology({ activeIds = [], compact = false }: TopologyProps) {
  const nodes = new Map(topologyNodes.map((node) => [node.id, node]));

  return (
    <div className={`topology ${compact ? "topology--compact" : ""}`}>
      <svg
        aria-label="Change topology from the session endpoint through login policy, Redis state, error contract, and tests"
        role="img"
        viewBox="0 0 680 245"
      >
        <defs>
          <marker id="topology-arrow" markerHeight="6" markerWidth="6" orient="auto" refX="5" refY="3">
            <path d="M0,0 L0,6 L6,3 z" className="topology__arrow" />
          </marker>
          <filter id="node-glow" height="180%" width="180%" x="-40%" y="-40%">
            <feGaussianBlur result="blur" stdDeviation="7" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {topologyEdges.map((edge) => {
          const from = nodes.get(edge.from);
          const to = nodes.get(edge.to);
          if (!from || !to) return null;
          const active = activeIds.includes(edge.from) && activeIds.includes(edge.to);
          const x1 = from.x + 54;
          const y1 = from.y + 22;
          const x2 = to.x - 8;
          const y2 = to.y + 22;
          return (
            <g key={`${edge.from}-${edge.to}`}>
              <path
                className={`topology__edge ${active ? "is-active" : ""}`}
                d={`M ${x1} ${y1} C ${x1 + 40} ${y1}, ${x2 - 40} ${y2}, ${x2} ${y2}`}
                markerEnd="url(#topology-arrow)"
              />
              {edge.label && !compact && (
                <text className="topology__edge-label" x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 7}>
                  {edge.label}
                </text>
              )}
            </g>
          );
        })}

        {topologyNodes.map((node) => {
          const active = activeIds.includes(node.id);
          return (
            <g
              className={`topology__node topology__node--${node.kind} ${active ? "is-active" : ""}`}
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
            >
              {active && <rect className="topology__node-glow" filter="url(#node-glow)" height="44" rx="12" width="116" />}
              <rect className="topology__node-box" height="44" rx="12" width="116" />
              <circle className="topology__node-dot" cx="15" cy="15" r="4" />
              <text className="topology__node-label" x="26" y="18">{node.label}</text>
              {!compact && <text className="topology__node-detail" x="15" y="33">{node.detail}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

