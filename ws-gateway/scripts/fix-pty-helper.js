// node-pty's prebuilt `spawn-helper` occasionally lands on disk without the
// execute bit (observed with npm 10+ on macOS). The helper is invoked via
// posix_spawnp inside node-pty; without +x every spawn fails with
// "posix_spawnp failed." This script restores the bit defensively.
//
// On Linux, prebuilds are absent and node-pty builds from source — the
// compiled helper already gets +x from its build system, so this is a no-op.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const prebuildsDir = path.join(root, "node_modules", "node-pty", "prebuilds");

if (!fs.existsSync(prebuildsDir)) process.exit(0);

for (const arch of fs.readdirSync(prebuildsDir)) {
  const helper = path.join(prebuildsDir, arch, "spawn-helper");
  if (!fs.existsSync(helper)) continue;
  try {
    fs.chmodSync(helper, 0o755);
  } catch {
    // Non-fatal; a Windows machine won't have POSIX perms anyway.
  }
}
