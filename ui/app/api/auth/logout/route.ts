import { getSession } from "@/lib/auth";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

export async function POST() {
  const session = await getSession();
  session.destroy();
  log.info("auth.logout");
  return new Response(null, { status: 204 });
}
