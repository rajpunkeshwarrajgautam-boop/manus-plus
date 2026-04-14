import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Monorepo lives under manus-plus; avoid tracing the parent RAG lockfile.
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
