// src/core/next/spatial.js — light 2D (x, z) collision, spatial queries and
// grid movement/pathing (ENGINE-NEXT-01 candidate). No physics engine.
//
// Two layers:
//   1. Tile grid: bounds, blocked cells, BFS path/reach with a fixed
//      neighbour order (N, E, S, W) so ties always resolve the same way.
//   2. Continuous shapes: circle/AABB overlap tests, a uniform spatial hash
//      for "who is near (x, z)" queries, and axis-separated slide movement.
// NavProvider: { isWalkable(x, z), findPath(from, to) } — gridNav() wraps a
// tile grid, navmeshNav() wraps the existing src/core/navmesh.js result, so
// game code depends on the interface and not on either implementation.
// Pure module: no rendering, no wall clock, no randomness.

// Fixed neighbour order. Never reorder: paths and AI tie-breaks depend on it.
export const DIRS4 = [
  { name: "up", dc: 0, dr: -1 },
  { name: "right", dc: 1, dr: 0 },
  { name: "down", dc: 0, dr: 1 },
  { name: "left", dc: -1, dr: 0 },
];
export const DIR_BY_NAME = Object.fromEntries(DIRS4.map((d) => [d.name, d]));

// blocked: array of [c, r] or { c, r }. originX/originZ is the world
// position of the centre of cell (0, 0); cellSize is the cell edge.
export function createGrid({ cols, rows, blocked = [], cellSize = 1, originX = 0, originZ = 0 }) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols * rows > 1000000) {
    throw new Error("createGrid: cols/rows must be positive integers (max 1e6 cells)");
  }
  const cells = new Uint8Array(cols * rows);
  for (const b of blocked) {
    const c = Array.isArray(b) ? b[0] : b.c;
    const r = Array.isArray(b) ? b[1] : b.r;
    if (!Number.isInteger(c) || !Number.isInteger(r) || c < 0 || r < 0 || c >= cols || r >= rows) {
      throw new Error(`createGrid: blocked cell out of bounds (${c}, ${r})`);
    }
    cells[r * cols + c] = 1;
  }
  return { cols, rows, cells, cellSize, originX, originZ };
}

export function inBounds(grid, c, r) {
  return Number.isInteger(c) && Number.isInteger(r) && c >= 0 && r >= 0 && c < grid.cols && r < grid.rows;
}
export function isBlocked(grid, c, r) {
  return !inBounds(grid, c, r) || grid.cells[r * grid.cols + c] === 1;
}
export function cellIndex(grid, c, r) { return r * grid.cols + c; }
export function cellKey(c, r) { return `${c},${r}`; }
export function cellToWorld(grid, c, r) {
  return { x: grid.originX + c * grid.cellSize, z: grid.originZ + r * grid.cellSize };
}
export function worldToCell(grid, x, z) {
  return { c: Math.round((x - grid.originX) / grid.cellSize), r: Math.round((z - grid.originZ) / grid.cellSize) };
}
export function manhattan(a, b) { return Math.abs(a.c - b.c) + Math.abs(a.r - b.r); }
export function chebyshev(a, b) { return Math.max(Math.abs(a.c - b.c), Math.abs(a.r - b.r)); }

// Breadth-first flood from `from`. Returns cells in visit order (which is
// deterministic: FIFO queue + DIRS4 order) as { c, r, cost, prev }.
// isOccupied(c, r) adds dynamic blockers (crates, units) on top of the grid.
// The start cell itself is never tested against isOccupied.
export function floodFill(grid, from, { maxCost = Infinity, isOccupied = null } = {}) {
  if (!inBounds(grid, from.c, from.r)) return [];
  const seen = new Int32Array(grid.cols * grid.rows).fill(-1);
  const out = [{ c: from.c, r: from.r, cost: 0, prev: -1 }];
  seen[cellIndex(grid, from.c, from.r)] = 0;
  for (let head = 0; head < out.length; head++) {
    const cur = out[head];
    if (cur.cost >= maxCost) continue;
    for (const d of DIRS4) {
      const c = cur.c + d.dc;
      const r = cur.r + d.dr;
      if (isBlocked(grid, c, r)) continue;
      const idx = cellIndex(grid, c, r);
      if (seen[idx] !== -1) continue;
      if (isOccupied && isOccupied(c, r)) continue;
      seen[idx] = out.length;
      out.push({ c, r, cost: cur.cost + 1, prev: head });
    }
  }
  return out;
}

// Shortest 4-neighbour path, excluding the start cell and including the
// goal. null when unreachable. The goal cell is allowed to be "occupied"
// when allowOccupiedGoal is set (walk up to a target, attack range checks).
export function findPath(grid, from, to, { isOccupied = null, maxCost = Infinity, allowOccupiedGoal = false } = {}) {
  if (!inBounds(grid, from.c, from.r) || isBlocked(grid, to.c, to.r)) return null;
  if (from.c === to.c && from.r === to.r) return [];
  const occ = isOccupied && allowOccupiedGoal
    ? (c, r) => !(c === to.c && r === to.r) && isOccupied(c, r)
    : isOccupied;
  const visited = floodFill(grid, from, { maxCost, isOccupied: occ });
  let node = visited.find((n) => n.c === to.c && n.r === to.r);
  if (!node) return null;
  const path = [];
  while (node.prev !== -1) {
    path.push({ c: node.c, r: node.r });
    node = visited[node.prev];
  }
  return path.reverse();
}

// Bresenham line of sight between cell centres: false when any cell strictly
// between the endpoints is blocked.
export function lineOfSight(grid, a, b, isOpaque = null) {
  let c = a.c;
  let r = a.r;
  const dc = Math.abs(b.c - a.c);
  const dr = Math.abs(b.r - a.r);
  const sc = a.c < b.c ? 1 : -1;
  const sr = a.r < b.r ? 1 : -1;
  let err = dc - dr;
  while (!(c === b.c && r === b.r)) {
    const e2 = err * 2;
    if (e2 > -dr) { err -= dr; c += sc; }
    if (e2 < dc) { err += dc; r += sr; }
    if (c === b.c && r === b.r) break;
    if (isBlocked(grid, c, r) || (isOpaque && isOpaque(c, r))) return false;
  }
  return true;
}

// --- Continuous shapes ------------------------------------------------
export function circlesOverlap(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  const rr = a.r + b.r;
  return dx * dx + dz * dz < rr * rr;
}
// AABB: { minX, minZ, maxX, maxZ }. Touching edges do not overlap.
export function aabbOverlap(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}
export function circleAabbOverlap(circle, box) {
  const nx = Math.max(box.minX, Math.min(circle.x, box.maxX));
  const nz = Math.max(box.minZ, Math.min(circle.z, box.maxZ));
  const dx = circle.x - nx;
  const dz = circle.z - nz;
  return dx * dx + dz * dz < circle.r * circle.r;
}
export function pointInAabb(x, z, box) {
  return x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ;
}

// Move a circle by (dx, dz) against static AABB obstacles, one axis at a
// time, so it slides along walls instead of sticking. Returns the new
// position and which axes were blocked.
export function moveCircle(circle, dx, dz, obstacles) {
  let x = circle.x;
  let z = circle.z;
  let hitX = false;
  let hitZ = false;
  if (dx !== 0) {
    const probe = { x: x + dx, z, r: circle.r };
    if (obstacles.some((o) => circleAabbOverlap(probe, o))) hitX = true;
    else x += dx;
  }
  if (dz !== 0) {
    const probe = { x, z: z + dz, r: circle.r };
    if (obstacles.some((o) => circleAabbOverlap(probe, o))) hitZ = true;
    else z += dz;
  }
  return { x, z, hitX, hitZ };
}

// Uniform spatial hash for circles. Query results are sorted by id so the
// caller's iteration order never depends on insertion or bucket order.
export function createSpatialHash(cellSize = 2) {
  if (!(cellSize > 0)) throw new Error("createSpatialHash: cellSize must be > 0");
  const buckets = new Map();
  const items = new Map();
  const key = (cx, cz) => cx * 73856093 ^ cz * 19349663;
  const span = (v, r) => [Math.floor((v - r) / cellSize), Math.floor((v + r) / cellSize)];
  return {
    get size() { return items.size; },
    clear() { buckets.clear(); items.clear(); },
    insert(id, x, z, r = 0) {
      if (items.has(id)) throw new Error(`spatial hash: duplicate id ${id}`);
      items.set(id, { id, x, z, r });
      const [x0, x1] = span(x, r);
      const [z0, z1] = span(z, r);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = key(cx, cz);
          let b = buckets.get(k);
          if (!b) buckets.set(k, (b = []));
          b.push(id);
        }
      }
    },
    // Ids whose circle overlaps the query circle, ascending.
    queryCircle(x, z, r) {
      const found = new Set();
      const [x0, x1] = span(x, r);
      const [z0, z1] = span(z, r);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const b = buckets.get(key(cx, cz));
          if (!b) continue;
          for (const id of b) {
            if (found.has(id)) continue;
            const it = items.get(id);
            if (circlesOverlap({ x, z, r }, it)) found.add(id);
          }
        }
      }
      return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    },
    // Nearest item to (x, z) within maxDist; ties go to the smaller id.
    nearest(x, z, maxDist = Infinity, filter = null) {
      let best = null;
      let bestD = Infinity;
      const candidates = maxDist === Infinity ? [...items.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : this.queryCircle(x, z, maxDist);
      for (const id of candidates) {
        if (filter && !filter(id)) continue;
        const it = items.get(id);
        const d = Math.hypot(it.x - x, it.z - z);
        if (d <= maxDist && d < bestD) { bestD = d; best = id; }
      }
      return best === null ? null : { id: best, distance: bestD };
    },
  };
}

// --- NavProvider adapters ---------------------------------------------
export function gridNav(grid, { isOccupied = null } = {}) {
  return {
    kind: "grid",
    isWalkable(x, z) {
      const { c, r } = worldToCell(grid, x, z);
      return !isBlocked(grid, c, r) && !(isOccupied && isOccupied(c, r));
    },
    findPath(from, to) {
      const path = findPath(grid, worldToCell(grid, from.x, from.z), worldToCell(grid, to.x, to.z), { isOccupied });
      return path ? path.map((p) => cellToWorld(grid, p.c, p.r)) : null;
    },
  };
}
// Wraps buildNavmesh() from src/core/navmesh.js (sim 2D y == world z).
export function navmeshNav(navmesh) {
  return {
    kind: "navmesh",
    isWalkable(x, z) { return navmesh.isWalkable(x, z); },
    findPath(from, to) {
      const path = navmesh.findPath({ x: from.x, y: from.z }, { x: to.x, y: to.z });
      return path ? path.map((p) => ({ x: p.x, z: p.y })) : null;
    },
  };
}
