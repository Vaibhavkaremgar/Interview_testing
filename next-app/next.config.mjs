import { fileURLToPath } from "url";
import path, { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use a relative path so Turbopack keeps the shim inside the project graph.
const faceMeshShim = "./shims/mediapipe-face-mesh.js";

const nextConfig = {
  turbopack: {
    root: __dirname,
    // Alias the UMD-only package to a tiny ESM shim so Turbopack stops
    // complaining about missing exports.
    resolveAlias: {
      "@mediapipe/face_mesh": faceMeshShim,
    },
  },
  webpack: (config) => {
    // Mirror the alias for Webpack builds.
    config.resolve.alias["@mediapipe/face_mesh"] = faceMeshShim;
    return config;
  },
};

export default nextConfig;
