import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  transpilePackages: ["@5ive-tech/sdk", "five-vm-wasm"],
  typescript: {
    ignoreBuildErrors: true,
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Polyfill Node.js core modules for the browser client
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        os: false,
      };
    }
    
    // Enable WASM support which the SDK relies on
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      layers: true,
    };

    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "five-vm-wasm": path.resolve(process.cwd(), "../five-wasm/pkg-bundler/five_vm_wasm.js"),
      "five-wasm": path.resolve(process.cwd(), "../five-wasm/pkg-bundler/five_vm_wasm.js"),
    };

    // Suppress specific warnings from the SDK's node.js imports
    config.ignoreWarnings = [
      { module: /five-sdk/, message: /Critical dependency/ },
      { message: /The generated code contains 'async\/await'/ },
    ];

    return config;
  },
};

export default nextConfig;
