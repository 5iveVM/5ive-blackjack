import type { NextConfig } from "next";

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

    // Suppress specific warnings from the SDK's node.js imports
    config.ignoreWarnings = [
      { module: /five-sdk/, message: /Critical dependency/ },
      { message: /The generated code contains 'async\/await'/ },
    ];

    return config;
  },
  output: "export",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
