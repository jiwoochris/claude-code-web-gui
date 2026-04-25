import Link from "next/link";
import { listSessions } from "@/lib/tmux";

function formatRelative(unixSec: number): string {
  if (!unixSec) return "";
  const diffMs = Date.now() - unixSec * 1000;
  if (diffMs < 0) return "방금 전";
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "방금 전";
  if (min < 60) return `${min}m 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h 전`;
  const d = Math.floor(hr / 24);
  return `${d}d 전`;
}

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let sessions: Awaited<ReturnType<typeof listSessions>> = [];
  try {
    sessions = await listSessions();
  } catch {
    sessions = [];
  }

  const recent = [...sessions]
    .sort((a, b) => b.created - a.created)
    .slice(0, 5);

  return (
    <div className="dashboard">
      <h2>반갑습니다 👋</h2>
      <p>
        현재 활성 세션 {sessions.length}개가 열려 있어요.
        <br />
        왼쪽에서 세션을 선택하거나 새로 만들어 시작하세요.
      </p>

      {recent.length > 0 && (
        <div className="section">
          <h3>최근 세션</h3>
          <ul className="recent">
            {recent.map((s) => (
              <li key={s.name}>
                <Link href={`/s/${encodeURIComponent(s.name)}`}>{s.name}</Link>
                <time>{formatRelative(s.created)}</time>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="tip">
        💡 팁: 탭을 닫아도 세션은 tmux에 살아있습니다. 언제든 다시 붙으세요.
      </div>
    </div>
  );
}
