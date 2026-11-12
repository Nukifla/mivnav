// Module-boundary enforcement for the frontend layering.
//
//   core/**      — the kernel: feature-agnostic. Defines the descriptors
//                  (chrome/feature.ts, layers/overlay.ts, ...) features plug
//                  into. MUST NOT import features/**.
//   features/**  — self-contained features; depend on core, register with it.
//   App.tsx / MapView.tsx — the composition root; may import both.
//
// The one rule below forbids the illegal direction (core -> features). It runs
// in `bun run check` and `just check`; a stray import fails the build.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "core-not-import-features",
      severity: "error",
      comment:
        "core/** is the feature-agnostic kernel and must not import features/**. " +
        "Invert the dependency: expose a hook/descriptor in core and register it " +
        "from the feature, then compose in App.tsx.",
      from: { path: "^src/core/" },
      to: { path: "^src/features/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".jsx"],
    },
  },
};
