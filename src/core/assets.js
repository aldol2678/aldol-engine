// Asset URI contract (pure core module — no rendering, no 'three').
//
// Manifest asset URIs are either:
//   builtin:<name>                      — a built-up primitive the renderer knows
//   glb:<relative path>.glb             — a real GLB model under the game directory
// A GLB reference is safe only when it is a relative path under the game
// directory: no parent traversal, no absolute path, no URL scheme.

export function isGlbUri(uri) {
  return typeof uri === "string" && uri.startsWith("glb:");
}

export function glbPath(uri) {
  return uri.slice("glb:".length);
}

export function isSafeGlbUri(uri) {
  if (!isGlbUri(uri)) return false;
  const p = glbPath(uri);
  return (
    p.endsWith(".glb") &&
    !p.includes("..") &&
    !p.startsWith("/") &&
    !/^[A-Za-z]+:/.test(p) &&
    /^[A-Za-z0-9._/-]+$/.test(p)
  );
}

export function glbAssets(manifest) {
  return (manifest.assets || []).filter((a) => isGlbUri(a.uri));
}
