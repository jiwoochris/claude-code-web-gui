import { notFound } from "next/navigation";
import { SessionShell } from "@/components/SessionShell";
import { SESSION_NAME_PATTERN } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function TerminalPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  if (!SESSION_NAME_PATTERN.test(name)) notFound();
  return <SessionShell name={name} />;
}
