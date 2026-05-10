import { promises as fs } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

// Per-slide speaker notes for a pptx, in presentation order.
// `notes[i]` is the body text of slide i+1; an empty string means the slide
// has no notes (or only the auto slide-number placeholder).
export interface PptxNotesResult {
  notes: string[];
}

export class PptxNotesError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "PptxNotesError";
  }
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

// Pull `Target` for a given `Id` from a .rels XML blob.
function relTargetById(relsXml: string, id: string): string | null {
  const re = new RegExp(
    `<Relationship\\b[^>]*\\bId="${id.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}"[^>]*\\bTarget="([^"]+)"`,
  );
  const m = relsXml.match(re);
  return m ? m[1] : null;
}

// Pull the first `Target` whose `Type` ends with the given suffix (e.g. "notesSlide").
function relTargetByTypeSuffix(relsXml: string, suffix: string): string | null {
  const re = new RegExp(
    `<Relationship\\b[^>]*\\bType="[^"]*${suffix.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}"[^>]*\\bTarget="([^"]+)"`,
  );
  const m = relsXml.match(re);
  return m ? m[1] : null;
}

// Resolve a relationship Target (which is relative to the .rels file's owner
// part) into a normalized absolute path inside the zip.
function resolveZipPath(ownerPath: string, target: string): string {
  if (target.startsWith("/")) return target.replace(/^\/+/, "");
  const ownerDir = path.posix.dirname(ownerPath);
  return path.posix.normalize(path.posix.join(ownerDir, target));
}

// Extract notes-body text from a notesSlide XML blob. Skips slide-number
// (`type="sldNum"`) and slide-thumbnail (`type="sldImg"`) placeholders so
// only the user-typed notes remain. Paragraphs are joined with newlines.
function extractNotesText(xml: string): string {
  const paragraphs: string[] = [];
  const shapeRe = /<p:sp\b[\s\S]*?<\/p:sp>/g;
  let shapeMatch: RegExpExecArray | null;
  while ((shapeMatch = shapeRe.exec(xml)) !== null) {
    const shape = shapeMatch[0];
    const phTypeMatch = shape.match(/<p:ph\b[^>]*\btype="([^"]+)"/);
    const phType = phTypeMatch?.[1];
    if (phType === "sldNum" || phType === "sldImg") continue;

    const paraRe = /<a:p\b[\s\S]*?<\/a:p>/g;
    let paraMatch: RegExpExecArray | null;
    while ((paraMatch = paraRe.exec(shape)) !== null) {
      const para = paraMatch[0];
      const runRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
      let runMatch: RegExpExecArray | null;
      let line = "";
      while ((runMatch = runRe.exec(para)) !== null) {
        line += decodeXmlEntities(runMatch[1]);
      }
      paragraphs.push(line);
    }
  }
  return paragraphs.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function extractPptxNotes(absPath: string): Promise<PptxNotesResult> {
  if (!absPath.toLowerCase().endsWith(".pptx")) {
    throw new PptxNotesError("Not a pptx file", 415);
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(absPath);
  } catch {
    throw new PptxNotesError("Cannot read file", 500);
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(buf);
  } catch {
    throw new PptxNotesError("Invalid pptx archive", 400);
  }

  const read = (zipPath: string): string | null => {
    const entry = zip.getEntry(zipPath);
    if (!entry || entry.isDirectory) return null;
    return entry.getData().toString("utf8");
  };

  // Determine slide order via presentation.xml's <p:sldIdLst>.
  const presentationXml = read("ppt/presentation.xml");
  const presentationRels = read("ppt/_rels/presentation.xml.rels");
  if (!presentationXml || !presentationRels) {
    return { notes: [] };
  }

  const sldIdRe = /<p:sldId\b[^>]*\br:id="([^"]+)"/g;
  const slideRIds: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = sldIdRe.exec(presentationXml)) !== null) {
    slideRIds.push(m[1]);
  }

  const notes: string[] = [];
  for (const rId of slideRIds) {
    const slideTarget = relTargetById(presentationRels, rId);
    if (!slideTarget) {
      notes.push("");
      continue;
    }
    // presentation.xml lives at ppt/presentation.xml, so relative targets
    // resolve under ppt/.
    const slidePath = resolveZipPath("ppt/presentation.xml", slideTarget);
    const slideRelsPath = path.posix.join(
      path.posix.dirname(slidePath),
      "_rels",
      `${path.posix.basename(slidePath)}.rels`,
    );
    const slideRelsXml = read(slideRelsPath);
    if (!slideRelsXml) {
      notes.push("");
      continue;
    }
    const notesTarget = relTargetByTypeSuffix(slideRelsXml, "/notesSlide");
    if (!notesTarget) {
      notes.push("");
      continue;
    }
    const notesPath = resolveZipPath(slidePath, notesTarget);
    const notesXml = read(notesPath);
    if (!notesXml) {
      notes.push("");
      continue;
    }
    notes.push(extractNotesText(notesXml));
  }

  return { notes };
}
