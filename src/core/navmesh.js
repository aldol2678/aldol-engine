// Grid-based navmesh (deterministic, pure JS — no rendering, no RNG).
//
// The walkable area is rasterized into square cells. A cell is blocked when
// its center falls inside an obstacle (house, tree, scarecrow) plus a margin.
// NPCs ask for a path with findPath(); the result is A* over the grid,
// smoothed by line-of-sight string pulling so NPCs cut corners instead of
// zig-zagging through cell centers. Same input always yields the same path:
// no Math.random, no Date, and the heap breaks ties by insertion order.
export const DEFAULT_CELL_SIZE = 0.5;

export function buildNavmesh({ bounds, obstacles = [], cellSize = DEFAULT_CELL_SIZE }) {
  const cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cellSize));
  const rows = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / cellSize));
  const blocked = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = bounds.minX + (c + 0.5) * cellSize;
      const y = bounds.minY + (r + 0.5) * cellSize;
      for (const o of obstacles) {
        const dx = x - o.x;
        const dy = y - o.y;
        const rad = (o.radius ?? 0.6) + 0.25;
        if (dx * dx + dy * dy < rad * rad) {
          blocked[r * cols + c] = 1;
          break;
        }
      }
    }
  }

  const toCell = (x, y) => ({
    c: Math.min(cols - 1, Math.max(0, Math.floor((x - bounds.minX) / cellSize))),
    r: Math.min(rows - 1, Math.max(0, Math.floor((y - bounds.minY) / cellSize))),
  });
  const cellCenter = (c, r) => ({
    x: bounds.minX + (c + 0.5) * cellSize,
    y: bounds.minY + (r + 0.5) * cellSize,
  });
  const isBlockedCell = (c, r) => c < 0 || r < 0 || c >= cols || r >= rows || blocked[r * cols + c] === 1;

  function isWalkable(x, y) {
    const { c, r } = toCell(x, y);
    return !isBlockedCell(c, r);
  }

  // True when the straight segment never enters a blocked cell.
  // Exact grid traversal (Amanatides & Woo): the segment is checked against
  // every cell it crosses, not sampled points — sampling can miss the closest
  // approach to an obstacle by up to half a sample step.
  function lineClear(ax, ay, bx, by) {
    const cellX = (x) => Math.floor((x - bounds.minX) / cellSize);
    const cellY = (y) => Math.floor((y - bounds.minY) / cellSize);
    let cx = cellX(ax);
    let cy = cellY(ay);
    const ex = cellX(bx);
    const ey = cellY(by);
    if (isBlockedCell(cx, cy) || isBlockedCell(ex, ey)) return false;
    const stepX = bx > ax ? 1 : bx < ax ? -1 : 0;
    const stepY = by > ay ? 1 : by < ay ? -1 : 0;
    const dx = Math.abs(bx - ax);
    const dy = Math.abs(by - ay);
    const tDeltaX = stepX !== 0 ? cellSize / dx : Infinity;
    const tDeltaY = stepY !== 0 ? cellSize / dy : Infinity;
    let tMaxX = stepX > 0
      ? ((cx + 1) * cellSize + bounds.minX - ax) / dx
      : stepX < 0 ? (ax - (cx * cellSize + bounds.minX)) / dx : Infinity;
    let tMaxY = stepY > 0
      ? ((cy + 1) * cellSize + bounds.minY - ay) / dy
      : stepY < 0 ? (ay - (cy * cellSize + bounds.minY)) / dy : Infinity;
    for (let guard = 0; guard < cols + rows + 10; guard++) {
      if (cx === ex && cy === ey) return true;
      if (tMaxX < tMaxY) { cx += stepX; tMaxX += tDeltaX; }
      else { cy += stepY; tMaxY += tDeltaY; }
      if (isBlockedCell(cx, cy)) return false;
    }
    return true;
  }

  function findPath(from, to) {
    const start = toCell(from.x, from.y);
    const goal = toCell(to.x, to.y);
    if (isBlockedCell(goal.c, goal.r)) return null;
    if (isBlockedCell(start.c, start.r)) {
      // Start inside an obstacle (e.g. spawned on a tree): walk straight out.
      return [{ x: to.x, y: to.y }];
    }
    if (start.c === goal.c && start.r === goal.r) return [{ x: to.x, y: to.y }];

    // A* with a binary heap; ties break by insertion order (deterministic).
    const open = [];
    const key = (c, r) => r * cols + c;
    const gScore = new Map();
    const cameFrom = new Map();
    const h = (c, r) => Math.hypot(c - goal.c, r - goal.r);
    let seq = 0;
    const push = (c, r, g, f) => {
      open.push({ c, r, g, f, seq: seq++ });
      let i = open.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (open[p].f < open[i].f || (open[p].f === open[i].f && open[p].seq < open[i].seq)) break;
        [open[p], open[i]] = [open[i], open[p]];
        i = p;
      }
    };
    const pop = () => {
      const top = open[0];
      const last = open.pop();
      if (open.length > 0) {
        open[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r2 = l + 1;
          let s = i;
          if (l < open.length && (open[l].f < open[s].f || (open[l].f === open[s].f && open[l].seq < open[s].seq))) s = l;
          if (r2 < open.length && (open[r2].f < open[s].f || (open[r2].f === open[s].f && open[r2].seq < open[s].seq))) s = r2;
          if (s === i) break;
          [open[s], open[i]] = [open[i], open[s]];
          i = s;
        }
      }
      return top;
    };
    push(start.c, start.r, 0, h(start.c, start.r));
    gScore.set(key(start.c, start.r), 0);
    const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
    let found = false;
    while (open.length > 0) {
      const cur = pop();
      if (cur.c === goal.c && cur.r === goal.r) {
        found = true;
        break;
      }
      if (cur.g > (gScore.get(key(cur.c, cur.r)) ?? Infinity)) continue;
      for (const [dc, dr, cost] of DIRS) {
        const nc = cur.c + dc;
        const nr = cur.r + dr;
        if (isBlockedCell(nc, nr)) continue;
        // No cutting corners through two blocked orthogonal neighbours.
        if (dc !== 0 && dr !== 0 && (isBlockedCell(cur.c + dc, cur.r) || isBlockedCell(cur.c, cur.r + dr))) continue;
        const ng = cur.g + cost;
        const k = key(nc, nr);
        if (ng < (gScore.get(k) ?? Infinity)) {
          gScore.set(k, ng);
          cameFrom.set(k, key(cur.c, cur.r));
          push(nc, nr, ng, ng + h(nc, nr));
        }
      }
    }
    if (!found) return null;
    const cells = [];
    let k = key(goal.c, goal.r);
    while (k !== key(start.c, start.r)) {
      cells.push(k);
      k = cameFrom.get(k);
    }
    cells.reverse();
    const raw = cells.map((kk) => cellCenter(kk % cols, Math.floor(kk / cols)));
    raw.push({ x: to.x, y: to.y });
    // String pulling: from the anchor, jump to the farthest raw point
    // reachable in a straight line. (The previous version stopped the scan
    // at j == i + 1 without verifying that segment, so a smoothed path
    // could cut a corner through a blocked cell.)
    const smooth = [];
    let anchor = { x: from.x, y: from.y };
    let i = 0;
    while (i < raw.length) {
      let j = raw.length - 1;
      while (j > i && !lineClear(anchor.x, anchor.y, raw[j].x, raw[j].y)) j--;
      smooth.push(raw[j]);
      anchor = raw[j];
      i = j + 1;
    }
    return smooth;
  }

  return { cols, rows, cellSize, bounds, isWalkable, lineClear, findPath };
}
