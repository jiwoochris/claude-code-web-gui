import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import AdmZip from "adm-zip";

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
const RENDER_PIPELINE_VERSION = "v5-pretendard-subfamily-fix";

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
//
// macOS Core Text strips weight tokens from family names ("Pretendard
// SemiBold" -> "Pretendard" base + SemiBold weight), so soffice can't
// reach the SemiBold/Medium/Light static OTFs by their subfamily names.
// `build-pretendard-weights.sh` ships companion OTFs whose family names
// have no weight token Core Text recognizes (PretendardCCWG-SB, …) — the
// pairs below route the subfamily requests to those custom names so the
// right glyphs end up in the PDF.
const FONT_SUBSTITUTIONS: ReadonlyArray<readonly [string, string]> = [
  ["Calibri", "Carlito"],
  ["Calibri Light", "Carlito"],
  ["Cambria", "Caladea"],
  ["Cambria Math", "Caladea"],
  ["Consolas", "JetBrains Mono"],
  ["Courier New", "JetBrains Mono"],
  ["Monaco", "JetBrains Mono"],
  ["맑은 고딕", "Pretendard Variable"],
  ["Malgun Gothic", "Pretendard Variable"],
  ["나눔고딕", "Pretendard Variable"],
  ["NanumGothic", "Pretendard Variable"],
  ["Pretendard Thin", "PretendardCCWG-TN"],
  ["Pretendard ExtraLight", "PretendardCCWG-EL"],
  ["Pretendard Light", "PretendardCCWG-LT"],
  ["Pretendard Medium", "PretendardCCWG-MD"],
  ["Pretendard SemiBold", "PretendardCCWG-SB"],
  ["Pretendard ExtraBold", "PretendardCCWG-EB"],
  ["Pretendard Black", "PretendardCCWG-BL"],
  ["바탕", "AppleMyungjo"],
  ["Batang", "AppleMyungjo"],
  ["굴림", "Pretendard Variable"],
  ["Gulim", "Pretendard Variable"],
  ["돋움", "Pretendard Variable"],
  ["Dotum", "Pretendard Variable"],
  ["Arial Unicode MS", "Pretendard Variable"],
  ["Times New Roman", "Times New Roman"],
];

// Typeface tokens that already encode weight. PowerPoint visually treats
// `b="1"` as a no-op when the typeface name carries one of these (the user
// already picked a weight subfamily); LibreOffice on macOS instead applies
// synthesized bold on top, which doubles the weight. Stripping b="1" from
// pptx XML before conversion brings our render in line with PowerPoint.
const WEIGHT_TOKEN_RE =
  /\b(Thin|ExtraLight|Extra Light|Light|Medium|SemiBold|Semibold|DemiBold|Demibold|ExtraBold|Extra Bold|Heavy|Black)\b/;

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
  //
  // The set node is named `FontPairs` in the registry schema (not
  // `Replacement` — that's the boolean toggle one level up); using the
  // wrong path silently no-ops every substitution.
  const userDir = path.join(profileDir, "user");
  await fs.mkdir(userDir, { recursive: true });

  const nodes = FONT_SUBSTITUTIONS.map(
    ([from, to], i) => `    <node oor:name="R${i}" oor:op="replace">
     <prop oor:name="ReplaceFont" oor:op="fuse"><value>${escXml(from)}</value></prop>
     <prop oor:name="SubstituteFont" oor:op="fuse"><value>${escXml(to)}</value></prop>
     <prop oor:name="Always" oor:op="fuse"><value>true</value></prop>
     <prop oor:name="OnScreenOnly" oor:op="fuse"><value>false</value></prop>
    </node>`,
  ).join("\n");

  const xcu = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <item oor:path="/org.openoffice.Office.Common/Font/Substitution"><prop oor:name="Replacement" oor:op="fuse"><value>true</value></prop></item>
  <item oor:path="/org.openoffice.Office.Common/Font/Substitution/FontPairs">
${nodes}
  </item>
</oor:items>
`;

  await fs.writeFile(
    path.join(userDir, "registrymodifications.xcu"),
    xcu,
    "utf8",
  );
}

// Rewrite a pptx in-place: drop b="1" from any <a:rPr> whose typeface
// already carries a weight token (SemiBold, Light, …). Returns true if any
// edit was made so the caller knows the file was touched. Non-pptx files
// are left alone and reported as unchanged.
async function preprocessPptxFonts(srcPath: string, dstPath: string): Promise<boolean> {
  if (!srcPath.toLowerCase().endsWith(".pptx")) return false;

  const buf = await fs.readFile(srcPath);
  let zip: AdmZip;
  try {
    zip = new AdmZip(buf);
  } catch {
    return false;
  }

  let changed = false;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    if (!name.startsWith("ppt/") || !name.endsWith(".xml")) continue;

    const text = entry.getData().toString("utf8");
    if (!WEIGHT_TOKEN_RE.test(text) || !text.includes('b="1"')) continue;

    let mutated = false;
    const rewritten = text.replace(
      /<a:rPr\b[^/>]*?(?:\/\s*>|>[\s\S]*?<\/a:rPr>)/g,
      (block) => {
        if (!block.includes('b="1"')) return block;
        if (!WEIGHT_TOKEN_RE.test(block)) return block;
        const stripped = block.replace(/\s+b="1"/, "");
        if (stripped !== block) {
          mutated = true;
          return stripped;
        }
        return block;
      },
    );

    if (mutated) {
      zip.updateFile(entry, Buffer.from(rewritten, "utf8"));
      changed = true;
    }
  }

  if (changed) {
    await fs.writeFile(dstPath, zip.toBuffer());
  }
  return changed;
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

  // For pptx, drop b="1" on weight-subfamily runs so soffice doesn't
  // double up the weight (see preprocessPptxFonts). The rewritten copy
  // lives next to the cache entry; if no rewrites were needed we hand
  // soffice the original path.
  const preppedPath = path.join(cacheDir, "input.pptx");
  const preprocessed = await preprocessPptxFonts(abs, preppedPath);
  const inputForSoffice = preprocessed ? preppedPath : abs;
  // soffice names the output after the input file's basename, so the
  // produced PDF is `input.pdf` when we hand it the rewritten copy.
  const sofficeOutBase = preprocessed
    ? "input"
    : path.basename(abs).replace(/\.[^.]+$/, "");

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
        inputForSoffice,
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

  // soffice writes <base>.pdf next to inputForSoffice, in --outdir.
  const producedPath = path.join(cacheDir, `${sofficeOutBase}.pdf`);
  if (!(await tryAccess(producedPath))) {
    throw new OfficeRenderError("Conversion produced no PDF.", 500);
  }
  if (producedPath !== pdfPath) {
    await fs.rename(producedPath, pdfPath);
  }
  const pdfStat = await fs.stat(pdfPath);

  // Drop the per-render profile + the rewritten input to keep the cache
  // tidy; the PDF is the only artifact we need to keep.
  fs.rm(profileDir, { recursive: true, force: true }).catch(() => {
    /* best effort */
  });
  if (preprocessed) {
    fs.rm(preppedPath, { force: true }).catch(() => {
      /* best effort */
    });
  }

  return { pdfPath, pdfSize: pdfStat.size };
}
