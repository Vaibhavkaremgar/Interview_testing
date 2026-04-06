// Simple ESM shim for @mediapipe/face_mesh so bundlers (Turbopack/Webpack)
// have something to import. The real package ships a UMD bundle with no
// exports, which causes "Export FaceMesh doesn't exist in target module"
// errors under Turbopack. We only use the TFJS runtime of
// @tensorflow-models/face-landmarks-detection, so a no-op stub is sufficient.

export const FaceMesh = class {};
export default FaceMesh;
export const VERSION = "shim-0.0.0";
