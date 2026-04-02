import type { NextConfig } from "next";

// Packages that must never be bundled by webpack (they use Node.js built-ins
// that aren't available in the webpack runtime). Applied to every compilation:
// server routes, instrumentation, and edge passes.
const SERVER_ONLY_PACKAGES = ["postgres", "@anthropic-ai/sdk"];

const nextConfig: NextConfig = {
  // Tells Next.js RSC bundler to skip these packages (uses native require at runtime)
  serverExternalPackages: SERVER_ONLY_PACKAGES,

  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Client bundle: stub out Node.js built-ins so imports compile to `false`
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        child_process: false,
        net: false,
        tls: false,
        crypto: false,
        stream: false,
      };
    } else {
      // Server / instrumentation bundle: mark these packages as CommonJS externals
      // so webpack emits `require("postgres")` instead of trying to bundle them.
      // serverExternalPackages doesn't cover the instrumentation compilation pass.
      type ExternalsFnCallback = (
        err: null,
        result?: string
      ) => void;
      type ExternalsContext = { request?: string };

      const existingExternals = config.externals ?? [];
      const existingArr = Array.isArray(existingExternals)
        ? existingExternals
        : [existingExternals];

      config.externals = [
        ...existingArr,
        (
          { request }: ExternalsContext,
          callback: ExternalsFnCallback
        ) => {
          if (
            request &&
            SERVER_ONLY_PACKAGES.some(
              (pkg) => request === pkg || request.startsWith(`${pkg}/`)
            )
          ) {
            callback(null, `commonjs2 ${request}`);
            return;
          }
          callback(null);
        },
      ];
    }
    return config;
  },
};

export default nextConfig;
