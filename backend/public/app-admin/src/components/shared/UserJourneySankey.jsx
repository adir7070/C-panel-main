import { useState, useEffect, useMemo } from "react";
import { Loader2 } from "lucide-react";
import api from "../../api/client";
import { localizeScreen } from "../../utils/labels";

const MAX_DEPTH = 5;
const MAX_CHILDREN = 5;
const NODE_WIDTH = 150;
const NODE_MIN_H = 32;
const NODE_MAX_H = 80;
const COL_GAP = 90;
const ROW_GAP = 14;
const PADDING = 30;

function buildTree(sessions, maxDepth) {
  const root = {
    name: "התחלה",
    count: sessions.length,
    children: new Map(),
    dropoffs: 0,
    isStart: true,
  };

  for (const session of sessions) {
    let node = root;
    const screens = (session.steps || []).map((s) => s.screen).filter(Boolean);
    for (let i = 0; i < Math.min(screens.length, maxDepth); i++) {
      const screen = screens[i];
      if (!node.children.has(screen)) {
        node.children.set(screen, {
          name: screen,
          count: 0,
          children: new Map(),
          dropoffs: 0,
        });
      }
      node = node.children.get(screen);
      node.count++;
    }
    node.dropoffs++;
  }
  return root;
}

function pruneChildren(node) {
  if (node.children.size > MAX_CHILDREN) {
    const sorted = [...node.children.entries()].sort(
      (a, b) => b[1].count - a[1].count
    );
    const top = sorted.slice(0, MAX_CHILDREN - 1);
    const rest = sorted.slice(MAX_CHILDREN - 1);
    const otherCount = rest.reduce((s, [, c]) => s + c.count, 0);
    const otherDropoffs = rest.reduce((s, [, c]) => s + c.dropoffs, 0);

    node.children = new Map(top);
    node.children.set("__other__", {
      name: "אחר",
      count: otherCount,
      children: new Map(),
      dropoffs: otherDropoffs,
      isOther: true,
    });
  }
  for (const child of node.children.values()) pruneChildren(child);
}

function layoutTree(root, totalSessions) {
  const nodes = [];
  const links = [];

  const heightOf = (count) => {
    const ratio = count / totalSessions;
    return Math.max(NODE_MIN_H, Math.min(NODE_MAX_H, ratio * NODE_MAX_H * 1.5));
  };

  function subtreeH(node) {
    const my = heightOf(node.count);
    if (node.children.size === 0) return my;
    const childH = [...node.children.values()].map(subtreeH);
    const stacked = childH.reduce((a, b) => a + b + ROW_GAP, -ROW_GAP);
    return Math.max(my, stacked);
  }

  function place(node, depth, yTop, parentNode) {
    const totalH = subtreeH(node);
    const myH = heightOf(node.count);
    const myY = yTop + (totalH - myH) / 2;
    const placed = {
      ...node,
      x: depth * (NODE_WIDTH + COL_GAP),
      y: myY,
      w: NODE_WIDTH,
      h: myH,
      depth,
    };
    nodes.push(placed);

    if (parentNode) {
      links.push({
        source: parentNode,
        target: placed,
        value: node.count,
        pct: Math.round((node.count / parentNode.count) * 100),
      });
    }

    let childY = yTop;
    for (const child of node.children.values()) {
      place(child, depth + 1, childY, placed);
      childY += subtreeH(child) + ROW_GAP;
    }
    return placed;
  }

  place(root, 0, 0, null);

  const totalH = subtreeH(root);
  const maxDepth = Math.max(...nodes.map((n) => n.depth));
  return { nodes, links, totalH, maxDepth };
}

function Pill({ node, totalSessions, flipX, isStart }) {
  const x = flipX(node.x);
  const pct = Math.round((node.count / totalSessions) * 100);
  const dropoffPct =
    node.count > 0 ? Math.round((node.dropoffs / node.count) * 100) : 0;
  const showDropoff = dropoffPct >= 5 && !isStart;

  return (
    <g>
      {/* Pill */}
      <rect
        x={x}
        y={node.y}
        width={node.w}
        height={node.h}
        rx={node.h / 2}
        ry={node.h / 2}
        fill={isStart ? "#1d4ed8" : node.isOther ? "#94a3b8" : "#3b82f6"}
        opacity={0.92}
      />
      {/* Label */}
      <text
        x={x + node.w / 2}
        y={node.y + node.h / 2 - 4}
        textAnchor="middle"
        fill="white"
        fontSize="12"
        fontWeight="600"
        style={{ direction: "rtl" }}
      >
        {truncate(localizeScreen(node.name), 16)}
      </text>
      {/* Sub-label */}
      <text
        x={x + node.w / 2}
        y={node.y + node.h / 2 + 10}
        textAnchor="middle"
        fill="white"
        fontSize="10"
        opacity="0.85"
      >
        {node.count} ({pct}%)
      </text>

      {/* Drop-off indicator */}
      {showDropoff && (
        <g>
          {/* small red curve coming out of the right side (visual right = lower x in RTL because flipped) */}
          <path
            d={`M ${x} ${node.y + node.h / 2}
                C ${x - 14} ${node.y + node.h / 2}, ${x - 14} ${
              node.y + node.h + 8
            }, ${x - 22} ${node.y + node.h + 8}`}
            stroke="#f87171"
            strokeWidth="3"
            fill="none"
            opacity="0.7"
          />
          <rect
            x={x - 50}
            y={node.y + node.h + 2}
            width={32}
            height={16}
            rx={3}
            fill="#fee2e2"
            stroke="#fca5a5"
            strokeWidth="0.5"
          />
          <text
            x={x - 34}
            y={node.y + node.h + 13}
            textAnchor="middle"
            fill="#b91c1c"
            fontSize="9"
            fontWeight="600"
          >
            {dropoffPct}%
          </text>
        </g>
      )}
    </g>
  );
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function Band({ link, flipX }) {
  // Source is on the right (lower depth, higher visual x in our flip)
  // Target is on the left (higher depth)
  const sx = flipX(link.source.x); // left edge in unflipped == right edge in visual
  const sy = link.source.y + link.source.h / 2;
  const tx = flipX(link.target.x) + link.target.w; // right edge in unflipped == left edge in visual
  const ty = link.target.y + link.target.h / 2;

  const midX = (sx + tx) / 2;
  const path = `M ${sx} ${sy} C ${midX} ${sy}, ${midX} ${ty}, ${tx} ${ty}`;

  // Band thickness — proportional to value vs max source height
  const thickness = Math.max(
    4,
    Math.min(link.source.h * 0.9, (link.value / link.source.count) * link.source.h)
  );

  // Label position
  const lx = (sx + tx) / 2;
  const ly = (sy + ty) / 2;

  return (
    <g>
      <path
        d={path}
        stroke="#bfdbfe"
        strokeWidth={thickness}
        fill="none"
        opacity="0.55"
        strokeLinecap="butt"
      />
      <rect
        x={lx - 18}
        y={ly - 9}
        width={36}
        height={18}
        rx={4}
        fill="#1e293b"
        opacity="0.78"
      />
      <text
        x={lx}
        y={ly + 4}
        textAnchor="middle"
        fill="white"
        fontSize="10"
        fontWeight="600"
      >
        {link.pct}%
      </text>
    </g>
  );
}

export default function UserJourneySankey({ phone }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!phone) return;
    setLoading(true);
    api
      .get(`/api/appinfo/app-activity/sessions`, { params: { phone, limit: 200 } })
      .then((r) => setSessions(r.data.sessions || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [phone]);

  const layout = useMemo(() => {
    if (!sessions.length) return null;
    const tree = buildTree(sessions, MAX_DEPTH);
    pruneChildren(tree);
    return layoutTree(tree, sessions.length);
  }, [sessions]);

  if (loading) {
    return (
      <div className="bg-white rounded-xl border p-12 text-center">
        <Loader2 size={24} className="animate-spin text-gray-400 mx-auto" />
      </div>
    );
  }

  if (!layout) {
    return (
      <div className="bg-white rounded-xl border p-12 text-center text-gray-400 text-sm">
        אין מספיק נתונים להצגת מסע משתמש מסכם
      </div>
    );
  }

  const { nodes, links, totalH, maxDepth } = layout;
  const totalWidth =
    (maxDepth + 1) * NODE_WIDTH + maxDepth * COL_GAP + PADDING * 2;
  const svgHeight = totalH + PADDING * 2;

  // Flip X so depth 0 is on the right (RTL)
  const innerWidth = (maxDepth + 1) * NODE_WIDTH + maxDepth * COL_GAP;
  const flipX = (x) => PADDING + (innerWidth - NODE_WIDTH - x);

  return (
    <div className="bg-white rounded-xl border p-6">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700">
          מסע משתמש מסכם
        </h3>
        <span className="text-xs text-gray-400">
          מבוסס על {sessions.length} הפעלות אחרונות
        </span>
      </div>
      <div className="overflow-x-auto" dir="ltr">
        <svg width={totalWidth} height={svgHeight} className="mx-auto block">
          {/* Bands first (behind) */}
          {links.map((link, i) => (
            <Band key={`l-${i}`} link={link} flipX={flipX} />
          ))}
          {/* Pills on top */}
          {nodes.map((n, i) => (
            <Pill
              key={`n-${i}`}
              node={n}
              totalSessions={sessions.length}
              flipX={flipX}
              isStart={n.isStart}
            />
          ))}
        </svg>
      </div>
      <div className="flex items-center justify-end gap-4 mt-4 text-xs text-gray-500" dir="rtl">
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-blue-600" /> מסך
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-slate-400" /> אחר
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-1 rounded bg-red-400" /> אחוז יציאה
        </div>
      </div>
    </div>
  );
}
