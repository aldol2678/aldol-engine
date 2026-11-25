// src/render/next/board.js — shared Three.js board scene for the grid-based
// next-gen games (ENGINE-NEXT-01 candidate). Render-side only: it never
// touches sim state and has no game rules.
//
// One call sets up what every board game page needs:
//   renderer (WebGL2 default) + lights + a tiled floor from a tile grid,
//   a camera that keeps the whole board visible in portrait and landscape,
//   pointer -> cell picking, and id-keyed mesh syncing.
// Primitives only (boxes, cylinders, cones…): no GLB is required, so there
// is nothing to fall back from. A game that wants GLB models still goes
// through src/render/asset-loader.js and keeps its primitive fallback.
import * as THREE from "three";

export const BOARD_THEMES = {
  forest: { sky: 0x101a12, fog: 0x101a12, floorA: 0x2f4a36, floorB: 0x2a4331, wall: 0x55624f, hemiSky: 0xcfe8d0, hemiGround: 0x1a2b1a, sun: 0xfff2d0 },
  lake: { sky: 0x0b1620, fog: 0x0b1620, floorA: 0x23405a, floorB: 0x1f3950, wall: 0x4a6076, hemiSky: 0xcfe8ff, hemiGround: 0x10202c, sun: 0xffffff },
  night: { sky: 0x0a0e1e, fog: 0x0a0e1e, floorA: 0x1d2440, floorB: 0x1a203a, wall: 0x3a3f5a, hemiSky: 0x8fa3ff, hemiGround: 0x141a30, sun: 0xdde6ff },
};

// cols/rows: board size in cells. blocked: Set of "c,r" wall keys (or a
// predicate). margin: extra world units kept visible around the board.
// insets: screen fractions reserved for HUD ({ top, bottom }), so the board
// is centred in the free area instead of under the panels.
export function createBoard({ container, cols, rows, isWall = () => false, theme = "night", cellSize = 1, margin = 0.75, insets = { top: 0.12, bottom: 0.14 }, shadows = true }) {
  const colors = typeof theme === "string" ? BOARD_THEMES[theme] || BOARD_THEMES.night : theme;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(colors.sky);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);

  // Board is centred on the origin: cell (c, r) -> world (x, z).
  const offX = -((cols - 1) * cellSize) / 2;
  const offZ = -((rows - 1) * cellSize) / 2;
  const cellToWorld = (c, r) => ({ x: offX + c * cellSize, z: offZ + r * cellSize });
  const worldToCell = (x, z) => ({ c: Math.round((x - offX) / cellSize), r: Math.round((z - offZ) / cellSize) });

  scene.add(new THREE.HemisphereLight(colors.hemiSky, colors.hemiGround, 0.85));
  const sun = new THREE.DirectionalLight(colors.sun, 1.25);
  const reach = Math.max(cols, rows) * cellSize;
  sun.position.set(reach * 0.35, reach * 1.2, reach * 0.45);
  sun.castShadow = shadows;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 0.5, far: reach * 4 });
  sun.shadow.bias = -0.0008;
  scene.add(sun, sun.target);

  // Floor + walls as two instanced meshes (one draw call each).
  const floorCells = [];
  const wallCells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) (isWall(c, r) ? wallCells : floorCells).push({ c, r });
  }
  const dummy = new THREE.Object3D();
  const floorMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(cellSize * 0.96, 0.12, cellSize * 0.96), new THREE.MeshStandardMaterial({ roughness: 1 }), Math.max(1, floorCells.length));
  floorMesh.receiveShadow = true;
  const tint = new THREE.Color();
  floorCells.forEach((cell, i) => {
    const p = cellToWorld(cell.c, cell.r);
    dummy.position.set(p.x, -0.06, p.z);
    dummy.updateMatrix();
    floorMesh.setMatrixAt(i, dummy.matrix);
    floorMesh.setColorAt(i, tint.setHex((cell.c + cell.r) % 2 === 0 ? colors.floorA : colors.floorB));
  });
  floorMesh.count = floorCells.length;
  scene.add(floorMesh);
  if (wallCells.length > 0) {
    const wallMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(cellSize, 0.9, cellSize), new THREE.MeshStandardMaterial({ color: colors.wall, roughness: 0.95 }), wallCells.length);
    wallMesh.castShadow = shadows;
    wallMesh.receiveShadow = true;
    wallCells.forEach((cell, i) => {
      const p = cellToWorld(cell.c, cell.r);
      dummy.position.set(p.x, 0.45, p.z);
      dummy.updateMatrix();
      wallMesh.setMatrixAt(i, dummy.matrix);
    });
    scene.add(wallMesh);
  }

  // Camera: tilted top-down, pulled back until the board (plus margin) fits
  // the free screen area. Portrait screens get a steeper, further view.
  const halfW = (cols * cellSize) / 2 + margin;
  const halfD = (rows * cellSize) / 2 + margin;
  function fit() {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    const free = Math.max(0.35, 1 - (insets.top || 0) - (insets.bottom || 0));
    const tilt = camera.aspect < 1 ? 1.25 : 1.05; // radians from horizontal
    const vHalf = THREE.MathUtils.degToRad(camera.fov / 2);
    const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
    const distForDepth = (halfD * Math.sin(tilt)) / Math.tan(vHalf * free) + halfD * Math.cos(tilt);
    const distForWidth = halfW / Math.tan(hHalf) + halfD * Math.cos(tilt);
    const dist = Math.max(distForDepth, distForWidth) * 1.04;
    // Shift the look-at point so the board sits in the free area.
    const shift = ((insets.top || 0) - (insets.bottom || 0)) * halfD * 1.1;
    camera.position.set(0, Math.sin(tilt) * dist, Math.cos(tilt) * dist - shift);
    camera.lookAt(0, 0, -shift);
    camera.updateProjectionMatrix();
  }
  fit();
  const onResize = () => fit();
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);

  // Pointer -> cell on the y = 0 plane. null when off the board.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  function pick(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    const cell = worldToCell(hit.x, hit.z);
    if (cell.c < 0 || cell.r < 0 || cell.c >= cols || cell.r >= rows) return null;
    return cell;
  }
  // Screen position (CSS px) of a cell centre — used by tests and probes to
  // tap a cell the way a player would.
  function cellToScreen(c, r) {
    const p = cellToWorld(c, r);
    const v = new THREE.Vector3(p.x, 0, p.z).project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }
  // Tap/click handler: fires onCell only for a press+release on the same
  // cell (a drag across the board is not a tap).
  function onCellTap(handler) {
    let down = null;
    renderer.domElement.addEventListener("pointerdown", (e) => { down = pick(e.clientX, e.clientY); });
    renderer.domElement.addEventListener("pointerup", (e) => {
      const up = pick(e.clientX, e.clientY);
      if (down && up && down.c === up.c && down.r === up.r) handler(up, e);
      down = null;
    });
    renderer.domElement.addEventListener("pointercancel", () => { down = null; });
  }

  // Flat highlight tiles (move range, selection, targets). set(cells, color)
  // replaces the layer; pooled so no meshes are created per frame.
  function createHighlightLayer({ y = 0.02, opacity = 0.45 } = {}) {
    const pool = [];
    const geo = new THREE.PlaneGeometry(cellSize * 0.9, cellSize * 0.9);
    return {
      set(cells, color = 0xffffff) {
        cells.forEach((cell, i) => {
          let m = pool[i];
          if (!m) {
            m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false }));
            m.rotation.x = -Math.PI / 2;
            scene.add(m);
            pool.push(m);
          }
          const p = cellToWorld(cell.c, cell.r);
          m.position.set(p.x, y, p.z);
          m.material.color.setHex(cell.color ?? color);
          m.visible = true;
        });
        for (let i = cells.length; i < pool.length; i++) pool[i].visible = false;
      },
    };
  }

  // Keep one mesh per id in step with a list of items from sim state.
  // make(item) -> Object3D, update(mesh, item, dt) positions/animates it.
  function createMeshSync(make, update) {
    const meshes = new Map();
    return {
      meshes,
      sync(items, dt = 0) {
        const alive = new Set();
        for (const item of items) {
          alive.add(item.id);
          let m = meshes.get(item.id);
          if (!m) {
            m = make(item);
            scene.add(m);
            meshes.set(item.id, m);
          }
          update(m, item, dt);
        }
        for (const [id, m] of meshes) {
          if (!alive.has(id)) { scene.remove(m); meshes.delete(id); }
        }
      },
      clear() {
        for (const m of meshes.values()) scene.remove(m);
        meshes.clear();
      },
    };
  }

  return {
    THREE, scene, camera, renderer, cols, rows, cellSize,
    cellToWorld, worldToCell, pick, cellToScreen, onCellTap, fit,
    createHighlightLayer, createMeshSync,
    render() { renderer.render(scene, camera); },
    info() { return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, webgl2: renderer.capabilities.isWebGL2 }; },
  };
}

// Ease a mesh toward a target position (render-only smoothing between ticks).
export function easeTo(mesh, x, y, z, dt, rate = 14) {
  const k = dt <= 0 ? 1 : 1 - Math.exp(-rate * dt);
  mesh.position.x += (x - mesh.position.x) * k;
  mesh.position.y += (y - mesh.position.y) * k;
  mesh.position.z += (z - mesh.position.z) * k;
}
