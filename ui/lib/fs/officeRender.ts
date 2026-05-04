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
