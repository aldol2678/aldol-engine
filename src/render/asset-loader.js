// Renderer-side GLB asset loader (NOT part of the deterministic sim).
//
// Loads `glb:` assets from the WorldForge manifest through the vendored
// three.js GLTFLoader. A missing or broken model resolves to null so the
// renderer can fall back to its built-up primitives — a bad asset must
// never block the game from starting.

import { GLTFLoader } from "./vendor/GLTFLoader.js";
import { glbAssets, glbPath, isSafeGlbUri } from "../core/assets.js";

export function createAssetLoader({ baseUrl = "./" } = {}) {
  const loader = new GLTFLoader();
  const cache = new Map();

  async function loadOne(asset) {
    if (cache.has(asset.id)) return cache.get(asset.id);
    const url = baseUrl + glbPath(asset.uri);
    const p = loader
      .loadAsync(url)
      .then((gltf) => {
        const scene = gltf.scene;
        const scale = asset.scale ?? 1;
        const s = Array.isArray(scale) ? scale : [scale, scale, scale];
        scene.scale.set(s[0], s[1], s[2]);
        scene.traverse((o) => {
          if (o.isMesh) o.castShadow = true;
        });
        return scene;
      })
      .catch(() => null);
    cache.set(asset.id, p);
    return p;
  }

  async function loadAll(manifest) {
    const loaded = new Map();
    const failed = [];
    for (const asset of glbAssets(manifest)) {
      if (!isSafeGlbUri(asset.uri)) {
        failed.push(asset.id);
        continue;
      }
      const scene = await loadOne(asset);
      if (scene) loaded.set(asset.id, scene);
      else failed.push(asset.id);
    }
    return { loaded, failed };
  }

  // A fresh clone per use; null when the asset did not load.
  function instance(loaded, assetId) {
    const scene = loaded.get(assetId);
    return scene ? scene.clone(true) : null;
  }

  return { loadOne, loadAll, instance };
}
