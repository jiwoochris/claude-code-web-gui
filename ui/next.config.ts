import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // node-pty is a native addon for the ws-gateway only; the UI itself has no
  // native deps, but iron-session relies on node:crypto which Next handles.
  //
  // Next 16's proxy/middleware truncates request bodies to 10 MB by default,
  // which breaks /api/fs/upload for any deck or asset bigger than that — the
  // body arrives without its multipart trailer and `req.formData()` throws
  // "Failed to parse body as FormData." Bumping the cap to 1 GiB matches the
  // upload route's own MAX_FILE_BYTES so the limit is enforced in one place.
  experimental: {
    proxyClientMaxBodySize: "1024mb",
  },
};

export default config;
