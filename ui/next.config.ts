import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // node-pty is a native addon for the ws-gateway only; the UI itself has no
  // native deps, but iron-session relies on node:crypto which Next handles.
};

export default config;
