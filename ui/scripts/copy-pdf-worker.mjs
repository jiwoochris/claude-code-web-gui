// Copies pdf.js's worker into /public/pdfjs/ and prepends a polyfill for
// Uint8Array#toHex / setFromHex so the worker runs on iOS Safari < 18.2 and
// older Chromes that don't yet ship those TC39 base16 methods. pdfjs-dist
// 5.x uses them internally during PDF parsing, otherwise blowing up with
// "a.toHex is not a function".

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

const polyfill = `/* injected: polyfills for Uint8Array#toHex / setFromHex */
(() => {
  const proto = Uint8Array.prototype;
  if (typeof proto.toHex !== "function") {
    Object.defineProperty(proto, "toHex", {
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
  if (typeof proto.setFromHex !== "function") {
    Object.defineProperty(proto, "setFromHex", {
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
})();
`;

const original = readFileSync(dst, "utf8");
if (!original.startsWith(polyfill)) {
  writeFileSync(dst, polyfill + original, "utf8");
}
console.log("copied + polyfilled", src, "->", dst);
