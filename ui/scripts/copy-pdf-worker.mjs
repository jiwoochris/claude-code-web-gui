// Copies pdf.js's worker + companion data into /public/pdfjs/ and prepends
// polyfills for recent TC39 methods that pdfjs-dist 5.x relies on but which
// iOS Safari < 18.4 and older Chromes don't ship yet:
//   - Uint8Array#toHex / setFromHex   (base16 methods)
//   - Map#getOrInsertComputed         (upsert proposal, also on WeakMap)
// Without these the worker blows up mid-parse with errors like
// "a.toHex is not a function" or "this[#rP].getOrInsertComputed is not
// a function" and the whole PDF/PPTX preview fails to render.
//
// The cmaps/ + standard_fonts/ directories are needed at runtime for any
// PDF that uses CID-keyed fonts (Korean/Japanese/Chinese CIDs reference
// predefined CMaps like KSCms-UHC-H) or one of the 14 standard PDF fonts.
// Without them pdf.js can't decode character codes back to glyphs and
// renders Korean text as random ASCII letters.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");

// Match the legacy build that PdfCanvasViewer loads on the client — the
// modern worker assumes JS features that older Android Chromium forks
// (Samsung Internet, In-App WebViews) don't ship by default.
const workerSrc = require.resolve(
  "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
);
// cmaps/ and standard_fonts/ live next to the package's package.json, not
// alongside the legacy build directory.
const pdfjsRoot = resolve(
  require.resolve("pdfjs-dist/package.json"),
  "..",
);
const dstDir = join(pkgRoot, "public", "pdfjs");
const dst = join(dstDir, "pdf.worker.min.mjs");

mkdirSync(dstDir, { recursive: true });
copyFileSync(workerSrc, dst);

for (const dir of ["cmaps", "standard_fonts"]) {
  const from = join(pdfjsRoot, dir);
  const to = join(dstDir, dir);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}

const polyfill = `/* injected: polyfills for pdfjs-dist 5.x on older browsers */
(() => {
  const u8 = Uint8Array.prototype;
  if (typeof u8.toHex !== "function") {
    Object.defineProperty(u8, "toHex", {
      value: function toHex() {
        let out = "";
        for (let i = 0; i < this.length; i++) {
          out += this[i].toString(16).padStart(2, "0");
        }
        return out;
      },
      configurable: true, writable: true,
    });
  }
  if (typeof u8.setFromHex !== "function") {
    Object.defineProperty(u8, "setFromHex", {
      value: function setFromHex(hex) {
        const clean = hex.length % 2 === 0 ? hex : hex.slice(0, hex.length - 1);
        const max = Math.min(clean.length / 2, this.length);
        let read = 0;
        for (let i = 0; i < max; i++) {
          const byte = parseInt(clean.substr(i * 2, 2), 16);
          if (Number.isNaN(byte)) break;
          this[i] = byte;
          read = i + 1;
        }
        return { read: read * 2, written: read };
      },
      configurable: true, writable: true,
    });
  }
  function defineGetOrInsertComputed(proto) {
    if (typeof proto.getOrInsertComputed === "function") return;
    Object.defineProperty(proto, "getOrInsertComputed", {
      value: function getOrInsertComputed(key, callbackfn) {
        if (typeof callbackfn !== "function") {
          throw new TypeError("callbackfn must be a function");
        }
        if (this.has(key)) return this.get(key);
        const value = callbackfn(key);
        this.set(key, value);
        return value;
      },
      configurable: true, writable: true,
    });
  }
  defineGetOrInsertComputed(Map.prototype);
  defineGetOrInsertComputed(WeakMap.prototype);
})();
`;

const original = readFileSync(dst, "utf8");
if (!original.startsWith(polyfill)) {
  writeFileSync(dst, polyfill + original, "utf8");
}
console.log("copied + polyfilled", workerSrc, "->", dst);
console.log("copied cmaps + standard_fonts ->", dstDir);
