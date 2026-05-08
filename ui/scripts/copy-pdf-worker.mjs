// Copies pdf.js's worker into /public/pdfjs/ and prepends polyfills for
// recent TC39 methods that pdfjs-dist 5.x relies on but which iOS Safari
// < 18.4 and older Chromes don't ship yet:
//   - Uint8Array#toHex / setFromHex   (base16 methods)
//   - Map#getOrInsertComputed         (upsert proposal, also on WeakMap)
// Without these the worker blows up mid-parse with errors like
// "a.toHex is not a function" or "this[#rP].getOrInsertComputed is not
// a function" and the whole PDF/PPTX preview fails to render.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");

const src = require.resolve("pdfjs-dist/build/pdf.worker.min.mjs");
const dstDir = join(pkgRoot, "public", "pdfjs");
const dst = join(dstDir, "pdf.worker.min.mjs");

mkdirSync(dstDir, { recursive: true });
copyFileSync(src, dst);

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
console.log("copied + polyfilled", src, "->", dst);
