import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app is a client-rendered editor backed by Supabase, so it opts out of
  // Cache Components / partial prerendering. The React Compiler stays off:
  // widgets read derived document data (formula engine, views) outside of
  // hooks, which automatic memoization would serve stale.
  reactCompiler: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
