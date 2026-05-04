import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const RENDERABLE_OFFICE_EXTS = new Set([
  "pptx",
  "ppt",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "odt",
  "odp",
  "ods",
  "rtf",
]);

const CACHE_ROOT = path.join(os.tmpdir(), "ccwg-render");

// Bump this when the conversion pipeline changes (font substitution table,
// soffice flags, etc.) so previously cached PDFs get regenerated.
const RENDER_PIPELINE_VERSION = "v2-fonts";

function sofficeBin(): string {
  if (process.env.SOFFICE_BIN) return process.env.SOFFICE_BIN;
  // macOS LibreOffice default install
  if (process.platform === "darwin") {
    return "/Applications/LibreOffice.app/Contents/MacOS/soffice";
  }
  return "soffice";
}

function cacheKey(abs: string, mtimeMs: number, size: number): string {
  const hash = crypto.createHash("sha1");
  hash.update(RENDER_PIPELINE_VERSION);
  hash.update("\0");
  hash.update(abs);
  hash.update("\0");
  hash.update(String(mtimeMs));
  hash.update("\0");
  hash.update(String(size));
  return hash.digest("hex");
}

export class OfficeRenderError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "OfficeRenderError";
  }
}

async function tryAccess(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Pairs of [missingFont, replacementFont]. The replacement is written into
// the LibreOffice user profile so soffice maps the missing font onto a
// metric-compatible (or visually similar) substitute that is actually
// installed. Without this, missing Office defaults like Calibri or
// 맑은 고딕 fall back to Liberation Sans / DejaVu and Hangul glyphs go
// missing on PDF export.
const FONT_SUBSTITUTIONS: ReadonlyArray<readonly [string, string]> = [
  ["Calibri", "Carlito"],
  ["Calibri Light", "Carlito"],
  ["Cambria", "Caladea"],
  ["Cambria Math", "Caladea"],
  ["Consolas", "Menlo"],
  ["맑은 고딕", "Apple SD Gothic Neo"],
  ["Malgun Gothic", "Apple SD Gothic Neo"],
  ["바탕", "AppleMyungjo"],
  ["Batang", "AppleMyungjo"],
  ["굴림", "Apple SD Gothic Neo"],
  ["Gulim", "Apple SD Gothic Neo"],
  ["돋움", "Apple SD Gothic Neo"],
  ["Dotum", "Apple SD Gothic Neo"],
  ["Arial Unicode MS", "Apple SD Gothic Neo"],
  ["Times New Roman", "Times New Roman"],
];

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function seedFontSubstitutions(profileDir: string): Promise<void> {
  // LibreOffice reads its font replacement table from
  // <profile>/user/registrymodifications.xcu. Seeding the file before the
  // first launch makes the substitutions take effect for the very first
  // (and only) headless conversion done in this profile.
  const userDir = path.join(profileDir, "user");
  await fs.mkdir(userDir, { recursive: true });

  const items = FONT_SUBSTITUTIONS.map(
    ([from, to], i) => `   <item oor:path="/org.openoffice.Office.Common/Font/Substitution/Replacement">
    <node oor:name="R${i}" oor:op="replace">
     <prop oor:name="ReplaceFont" oor:op="fuse"><value>${escXml(from)}</value></prop>
     <prop oor:name="SubstituteFont" oor:op="fuse"><value>${escXml(to)}</value></prop>
     <prop oor:name="Always" oor:op="fuse"><value>true</value></prop>
     <prop oor:name="OnScreenOnly" oor:op="fuse"><value>false</value></prop>
    </node>
   </item>`,
  ).join("\n");

  const xcu = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <item oor:path="/org.openoffice.Office.Common/Font/Substitution"><prop oor:name="Replacement" oor:op="fuse"><value>true</value></prop></item>
${items}
</oor:items>
`;

  await fs.writeFile(
    path.join(userDir, "registrymodifications.xcu"),
    xcu,
    "utf8",
  );
}

async function ensureSoffice(): Promise<string> {
  const bin = sofficeBin();
  const ok =
    bin === "soffice"
      ? true // resolved on PATH; the spawn itself will fail if missing
      : await tryAccess(bin);
  if (!ok) {
    throw new OfficeRenderError(
      "LibreOffice (soffice) is not available on the server.",
      503,
    );
  }
  return bin;
}

export async function renderOfficeToPdf(abs: string): Promise<{
  pdfPath: string;
  pdfSize: number;
}> {
  const stat = await fs.stat(abs);
  await fs.mkdir(CACHE_ROOT, { recursive: true });
  const key = cacheKey(abs, stat.mtimeMs, stat.size);
  const cacheDir = path.join(CACHE_ROOT, key);
  const pdfPath = path.join(cacheDir, "out.pdf");

  // Cache hit.
  if (await tryAccess(pdfPath)) {
    const pdfStat = await fs.stat(pdfPath);
    return { pdfPath, pdfSize: pdfStat.size };
  }

  await fs.mkdir(cacheDir, { recursive: true });
  const bin = await ensureSoffice();

  // Run soffice in a per-render user profile dir so concurrent invocations
  // don't race on the default profile lock.
  const profileDir = path.join(cacheDir, "profile");
  await fs.mkdir(profileDir, { recursive: true });
  const userProfileArg = `-env:UserInstallation=file://${profileDir}`;
  await seedFontSubstitutions(profileDir);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      bin,
      [
        userProfileArg,
        "--headless",
        "--norestore",
        "--nologo",
        "--nofirststartwizard",
        "--convert-to",
        "pdf",
        "--outdir",
        cacheDir,
        abs,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    proc.stdout.on("data", () => {
      /* discard */
    });
    proc.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `soffice exited ${code}`));
      } else {
        resolve();
      }
    });
  });

  // soffice writes <base>.pdf next to abs, in --outdir.
  const base = path.basename(abs).replace(/\.[^.]+$/, "");
  const producedPath = path.join(cacheDir, `${base}.pdf`);
  if (!(await tryAccess(producedPath))) {
    throw new OfficeRenderError("Conversion produced no PDF.", 500);
  }
  if (producedPath !== pdfPath) {
    await fs.rename(producedPath, pdfPath);
  }
  const pdfStat = await fs.stat(pdfPath);

  // Drop the per-render profile to keep the cache tidy.
  fs.rm(profileDir, { recursive: true, force: true }).catch(() => {
    /* best effort */
  });

  return { pdfPath, pdfSize: pdfStat.size };
}
