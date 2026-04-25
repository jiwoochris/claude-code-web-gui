import { timingSafeEqual } from "node:crypto";
import { LOGIN_RATE_LIMIT } from "@/lib/session";
import { getSession } from "@/lib/auth";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, Buffer.alloc(ab.length));
    return false;
  }
  return timingSafeEqual(ab, bb);
}

const attempts = new Map<string, { count: number; until: number }>();

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = attempts.get(ip);
  if (rec && rec.until > now) {
    const retryAfter = Math.ceil((rec.until - now) / 1000);
    log.warn("auth.login.rate_limited", { ip, retryAfter });
    return new Response("Too many attempts", {
      status: 429,
      headers: { "Retry-After": String(retryAfter) },
    });
  }

  const body = (await req.json().catch(() => ({}))) as { password?: unknown };
  const password = typeof body.password === "string" ? body.password : "";
  const expected = process.env.SHARED_PASSWORD ?? "";

  const ok = expected.length > 0 && safeEqual(password, expected);

  if (!ok) {
    const count = (rec?.count ?? 0) + 1;
    const next: { count: number; until: number } = { count, until: 0 };
    if (count >= LOGIN_RATE_LIMIT.maxAttempts) {
      next.until = now + LOGIN_RATE_LIMIT.lockMinutes * 60 * 1000;
    }
    attempts.set(ip, next);
    log.warn("auth.login.failed", { ip, count });
    return new Response("Unauthorized", { status: 401 });
  }

  attempts.delete(ip);
  const session = await getSession();
  session.authed = true;
  session.issuedAt = now;
  await session.save();
  log.info("auth.login.success", { ip });
  return Response.json({ ok: true });
}
