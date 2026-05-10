# Claude Code Web GUI 기획서

> **버전** 0.6 · **작성일** 2026-05-05 · **배포 범위** 사내망 전용
>
> **변경 이력**
> - v0.6: §12 파일 업로드 추가 — LNB 파일 트리에 드래그 앤 드롭 / 파일 선택 업로드 지원. 폴더 노드에 드롭 시 해당 폴더, 영역에 드롭 시 현재 선택 파일의 부모 폴더(미선택 시 루트)로 저장. 워크스페이스 마운트는 `:rw`. 수정·삭제·디렉터리 생성 API는 여전히 없음.
> - v0.5: §12 파일 뷰어 추가 — 고정 루트(`WORKSPACE_ROOT`) 기반 읽기 전용 Explorer. 트리/프리뷰/다운로드(zip)/SSE 실시간 워치.
> - v0.4: 인증 간소화 — bcrypt 해시 제거, 평문 비밀번호 환경변수 + 상수시간 비교. 세션 유지 기간·CORS origin은 코드 상수로 이동.
> - v0.3: 화면 구조를 LNB(좌측 내비게이션) + 메인 영역으로 재편. 와이어프레임 추가.
> - v0.2: Google OAuth 제거 → 공용 비밀번호 1개 방식으로 변경. IP:port 직접 접속 지원.
> - v0.1: 최초 작성.

---

## 1. 개요

Claude Code를 `tmux` 위에서 운용 중이나 SSH + 터미널 진입 장벽이 높아 팀원 접근성이 떨어지는 문제를 해결하기 위한 사내 웹 GUI. 브라우저에서 세션 이름을 입력하고 버튼 한 번으로 Claude Code가 돌아가는 tmux 세션에 붙거나 새로 만들 수 있어야 한다.

**핵심 원칙**

- tmux의 세션 지속성을 그대로 활용한다. 백엔드는 상태 관리를 하지 않는다.
- 브라우저 연결이 끊겨도 Claude Code 세션은 살아 있고, 재접속 시 `tmux attach`로 화면이 복원된다.
- 사내망 전용. 팀 공용 비밀번호 1개로 접근을 통제하고, 한 번 로그인하면 장기간 유지된다.

---

## 2. 목표 / 비목표

### 목표

- `tmux new -s <name>` / `tmux attach -t <name>`을 웹에서 1-click으로 대체한다.
- 세션 리스트 조회, 생성, 삭제 기능 제공.
- 공용 비밀번호 기반 로그인, 90일 슬라이딩 세션 (환경변수로 조정 가능).
- IP:port 직접 접속 지원 (별도 도메인·TLS·외부 서비스 불필요).
- 기존 tmux 사용 습관을 깨뜨리지 않는다 (단축키, 창 분할 등은 tmux가 그대로 처리).

### 비목표

- **편집 가능한** 에디터, Git UI, 멀티 패널 등 본격 IDE 기능은 구현하지 않는다. (읽기 전용 파일 뷰어 + 다운로드는 v0.5에서 포함 — §12)
- 외부망 공개, B2C 서비스화.
- 사용자별 VM 격리 (단일 호스트 다중 사용자 전제).

---

## 3. 사용자 시나리오

1. 사용자가 `http://<서버IP>:3000` (예: `http://10.10.1.50:3000`)에 접속한다.
2. 미로그인 상태면 로그인 페이지로 리다이렉트. 공용 비밀번호를 입력한다.
3. 비밀번호 일치 시 세션 쿠키가 발급되고 루트 페이지에 살아 있는 tmux 세션 목록이 보인다.
4. 신규 생성: 이름 입력 → **새 세션 생성하기** 클릭 → `tmux new-session -d -s <name>` 실행 → `/s/<name>`으로 이동 → 해당 세션에 attach.
5. 기존 세션: 리스트에서 이름 클릭 → `/s/<name>`으로 이동 → attach.
6. 탭 닫고 다음 날 다시 들어와도 쿠키가 살아 있어 로그인 생략, tmux 세션도 그대로.
7. 비밀번호를 회전하면(환경변수 교체 → 재시작) 기존 쿠키는 모두 무효화되어 전원 재로그인.

---

## 4. 아키텍처

```
┌─────────────────────────────────┐
│ Browser                         │
│  ├─ Next.js App (UI)            │
│  └─ xterm.js Terminal           │
└──────────┬──────────────────────┘
           │ HTTP / WS (same origin)
┌──────────▼──────────────────────┐
│ nginx (선택, 같은 오리진 프록시)  │
│  /         → Next.js :3000      │
│  /api/*    → Next.js :3000      │
│  /ws/*     → WS Gateway :3001   │
└──────────┬──────────────────────┘
           │
   ┌───────┴────────┐
   ▼                ▼
┌─────────────────┐  ┌─────────────────┐
│ Next.js 16      │  │ WS Gateway      │
│ (App Router     │  │ (ws + node-pty) │
│  + iron-session)│  │ (iron-session   │
│                 │  │  쿠키 복호화)     │
└─────┬───────────┘  └────────┬────────┘
      │ tmux CLI              │ spawn
      │ (list/new/kill)       │  tmux attach
      ▼                       ▼
      ┌────────────────────┐
      │   tmux server      │
      │   └─ Claude Code   │
      └────────────────────┘
```

단일 호스트 단일 컨테이너로도 구동 가능하나, UI와 WS는 프로세스를 분리한다 (Next.js Route Handler의 WebSocket 지원이 제한적이라 `node-pty` 바인딩은 전용 Node 프로세스가 관리한다). nginx는 포트 통합·정적 파일 캐싱·rate limit을 원할 때만 두면 된다. 가장 간단한 구성이라면 브라우저가 `http://<IP>:3000`(UI)와 `ws://<IP>:3001`(WS)에 직접 붙어도 동작하지만, 이 경우 WS 쿠키 전송을 위해 두 포트가 같은 오리진처럼 인식되도록 프론트 코드에서 명시적으로 `credentials: "include"`를 설정해야 한다. 권장은 nginx로 같은 오리진(:3000)에 통합.

---

## 5. 기술 스택

| 레이어 | 선택 | 비고 |
|---|---|---|
| 프론트엔드 | **Next.js 16.2** (App Router, React 19, Turbopack) | 최신 안정 버전. RSC 기본, Server Actions 활용 |
| 터미널 렌더러 | `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl` | 성능·스크롤 버퍼 |
| 인증 | **Iron Session** (암호화된 세션 쿠키) + 상수시간 비교 | 외부 DB/Provider 불필요 |
| WS 게이트웨이 | Node.js 20 LTS + `ws` + `node-pty` | Next.js와 별도 프로세스 |
| tmux 제어 | `child_process.exec` → `tmux` CLI | 파싱은 `-F` 포맷 지정 |
| 리버스 프록시 | nginx (선택) | 포트 통합·rate limit 용도. 없어도 동작 |
| 배포 | Docker Compose (ui, ws, [nginx]) | 사내 Linux 서버 1대 |
| 로그 | pino + 파일 로테이션 | 감사 로그 포함 |

> Next.js 버전은 "최신 안정" 정책을 따른다. 16.2 기준으로 작성되어 있으나 릴리스 주기에 맞춰 상향 조정.

---

## 6. 인증 설계

### 6.1 방식 개요

- 팀 전체가 공유하는 **공용 비밀번호 1개**로 인증.
- 환경변수 `SHARED_PASSWORD`에 비밀번호 평문을 두고, 요청 시 **상수시간 비교**(`crypto.timingSafeEqual`)로 검증. 사내망 + 단일 공용 비밀번호 + `.env` 파일 권한 0600 환경에서는 bcrypt 해시의 추가 이점이 작아 미니멀 구성으로 간다.
- 로그인 성공 시 **암호화된 세션 쿠키**(Iron Session)를 발급. `SESSION_SECRET`만 있으면 서명·암호화가 모두 해결되므로 별도 해시 키가 필요 없다.
- 외부 OAuth Provider·데이터베이스·도메인·TLS·해시 라이브러리 모두 불필요.

> **주의**: `SHARED_PASSWORD`는 평문이므로 `.env` 파일 권한(0600) 관리가 더 중요하다. Git 커밋 금지, 서버 접근 인원 최소화, 분기 1회 회전을 권장한다.

### 6.2 흐름

```
Browser → GET /login                          (미인증 상태)
        → POST /api/auth/login { password }
        → 서버: timingSafeEqual(입력, process.env.SHARED_PASSWORD)
        → 성공 시 iron-session 쿠키 발급 (HttpOnly, SameSite=Lax, 90일)
        → 302 → /
```

### 6.3 구현 (요약)

**설치**
```bash
npm i iron-session
```
(bcrypt 불필요. Node 내장 `crypto.timingSafeEqual`만으로 충분.)

**상수 및 세션 설정**
```ts
// lib/session.ts
import type { SessionOptions } from "iron-session";

// ── 하드코딩 상수 (자주 바뀌지 않고 비밀도 아님) ────────────────
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 90;   // 90일
export const LOGIN_RATE_LIMIT = { maxAttempts: 5, lockMinutes: 15 };
export const COOKIE_NAME = "claude_gui_session";
// ─────────────────────────────────────────────────────────

export interface SessionData {
  authed: true;
  issuedAt: number;
}

export const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET!,          // 32+ chars, 환경변수
  cookieName: COOKIE_NAME,
  ttl: SESSION_TTL_SECONDS,
  cookieOptions: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,                                 // 사내망 HTTP 허용
    maxAge: SESSION_TTL_SECONDS,
  },
};
```

> `SESSION_SECRET`이 교체되면 기존 쿠키는 모두 복호화 불가가 되어 전원 재로그인. 이게 강제 로그아웃 수단이다.

**로그인 라우트** (상수시간 비교)
```ts
// app/api/auth/login/route.ts
import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { timingSafeEqual } from "node:crypto";
import {
  sessionOptions, type SessionData, LOGIN_RATE_LIMIT,
} from "@/lib/session";

// 타이밍 공격 방지: 길이가 달라도 동일한 시간을 쓰도록.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // 길이 불일치 시에도 한 번은 비교해 timing 누출 차단
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, Buffer.alloc(ab.length));
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// 프로세스 단일 전제. 멀티 인스턴스 배포 시 Redis 등으로 교체 필요.
const attempts = new Map<string, { count: number; until: number }>();

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const now = Date.now();
  const rec = attempts.get(ip);
  if (rec && rec.until > now) {
    return new Response("Too many attempts", { status: 429 });
  }

  const { password } = await req.json().catch(() => ({ password: "" }));
  const expected = process.env.SHARED_PASSWORD ?? "";
  const ok = typeof password === "string" && expected.length > 0
             && safeEqual(password, expected);

  if (!ok) {
    const next = { count: (rec?.count ?? 0) + 1, until: 0 };
    if (next.count >= LOGIN_RATE_LIMIT.maxAttempts) {
      next.until = now + LOGIN_RATE_LIMIT.lockMinutes * 60 * 1000;
    }
    attempts.set(ip, next);
    return new Response("Unauthorized", { status: 401 });
  }

  attempts.delete(ip);
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  session.authed = true;
  session.issuedAt = now;
  await session.save();
  return Response.json({ ok: true });
}
```

**미들웨어로 가드**
```ts
// middleware.ts
import { NextResponse, type NextRequest } from "next/server";
import { getIronSession } from "iron-session";
import { sessionOptions, type SessionData } from "@/lib/session";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/login") || pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  const res = NextResponse.next();
  const session = await getIronSession<SessionData>(req, res, sessionOptions);
  if (!session.authed) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
```

### 6.4 세션 유지 정책

- **기본 만료**: 90일 (`lib/session.ts`의 `SESSION_TTL_SECONDS` 상수). 환경별로 다를 이유가 없어 하드코딩.
- **슬라이딩 갱신**: 페이지 진입 시마다 `session.save()`로 쿠키 만료 시각을 재설정하는 얇은 헬퍼를 middleware에 추가 가능. 이 경우 매일 한 번이라도 접속하면 사실상 무기한 유지.
- **명시 로그아웃**: `POST /api/auth/logout` → `session.destroy()` → 쿠키 제거.
- **강제 만료**: `SESSION_SECRET` 회전 → 컨테이너 재시작 → 기존 쿠키 전량 무효. 인원 변동/유출 의심 시 대응 수단.
- **비밀번호 회전**: `SHARED_PASSWORD` 환경변수 교체 → 재시작. 기존에 이미 로그인한 사람들의 쿠키는 `SESSION_SECRET`이 유지되는 한 그대로 유효하다 (즉, "새로 로그인하는 사람에게만 새 비밀번호 요구"). 전원 재인증이 필요하면 `SESSION_SECRET`도 함께 교체.

### 6.5 접근 제어

- middleware가 `/login`과 `/api/auth/*` 외 모든 경로를 가드.
- WebSocket 게이트웨이는 업그레이드 시점에 동일 세션 쿠키를 `iron-session`으로 복호화해 `authed === true`를 확인. 실패 시 `4401`로 종료.

### 6.6 WebSocket 쪽 검증 스니펫

```ts
// ws-gateway/index.ts (발췌)
import { unsealData } from "iron-session";
import { parse as parseCookie } from "cookie";

wss.on("connection", async (ws, req) => {
  const cookies = parseCookie(req.headers.cookie ?? "");
  const raw = cookies["claude_gui_session"];
  let authed = false;
  try {
    const data = await unsealData<{ authed?: boolean }>(raw ?? "", {
      password: process.env.SESSION_SECRET!,
    });
    authed = data?.authed === true;
  } catch { /* invalid */ }

  if (!authed) { ws.close(4401, "Unauthorized"); return; }
  // ... node-pty spawn 로직
});
```

---

## 7. API 설계

### 7.1 REST (Next.js Route Handler)

| Method | Path | 설명 | 응답 |
|---|---|---|---|
| POST | `/api/auth/login` | `{ password }` 바디로 로그인 | `200 { ok: true }` / `401` / `429` |
| POST | `/api/auth/logout` | 세션 파기 | `204` |
| GET | `/api/sessions` | 현재 tmux 세션 리스트 | `[{ name, created, attached, windows }]` |
| POST | `/api/sessions` | `{ name }` 바디로 신규 생성 | `201 { name }` / `409` (중복) |
| DELETE | `/api/sessions/:name` | 세션 종료 (`tmux kill-session`) | `204` |

**세션 이름 검증**: `^[a-zA-Z0-9_-]{1,32}$` — 쉘 인젝션 차단.

**구현 스니펫**

```ts
// app/api/sessions/route.ts
import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sessionOptions, type SessionData } from "@/lib/session";

const run = promisify(execFile);

async function requireAuth() {
  const s = await getIronSession<SessionData>(await cookies(), sessionOptions);
  return s.authed === true;
}

export async function GET() {
  if (!(await requireAuth())) return new Response("Unauthorized", { status: 401 });

  const { stdout } = await run("tmux", [
    "list-sessions", "-F",
    "#{session_name}\t#{session_created}\t#{?session_attached,1,0}\t#{session_windows}",
  ]).catch(() => ({ stdout: "" }));

  const sessions = stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [name, created, attached, windows] = line.split("\t");
    return { name, created: Number(created), attached: attached === "1", windows: Number(windows) };
  });
  return Response.json(sessions);
}

export async function POST(req: Request) {
  if (!(await requireAuth())) return new Response("Unauthorized", { status: 401 });

  const { name } = await req.json();
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) {
    return new Response("Invalid name", { status: 400 });
  }

  try {
    await run("tmux", ["new-session", "-d", "-s", name]);
    return Response.json({ name }, { status: 201 });
  } catch (e: any) {
    if (/duplicate/i.test(e.stderr ?? "")) return new Response("Conflict", { status: 409 });
    throw e;
  }
}
```

### 7.2 WebSocket 프로토콜

경로: `ws://<서버IP>:3001/ws/:name` (같은 오리진 프록시 구성이면 `ws://<서버IP>:3000/ws/:name`)

**인증**: 브라우저가 보내는 `claude_gui_session` 쿠키를 WS 게이트웨이가 `iron-session`의 `unsealData`로 복호화해 `authed === true` 확인. 실패 시 `4401 Unauthorized`로 끊는다. (§6.6 스니펫 참고)

**프레임 형식**

- 바이너리 프레임 (터미널 I/O): PTY stdout → 클라이언트 / 클라이언트 키 입력 → PTY stdin. 그대로 통과.
- 텍스트 프레임 (제어): JSON.
  - `{ "type": "resize", "cols": 120, "rows": 40 }` — xterm의 `onResize` 이벤트에서 전송, 서버는 `pty.resize()` 호출.
  - `{ "type": "ping" }` / `{ "type": "pong" }` — 30초 heartbeat.

**서버 스니펫**

```ts
// ws-gateway/index.ts
import { WebSocketServer } from "ws";
import * as pty from "node-pty";
import { unsealData } from "iron-session";
import { parse as parseCookie } from "cookie";

const wss = new WebSocketServer({ port: 3001 });

wss.on("connection", async (ws, req) => {
  // 1) 쿠키 복호화로 인증
  const cookies = parseCookie(req.headers.cookie ?? "");
  const raw = cookies["claude_gui_session"];
  let authed = false;
  try {
    const data = await unsealData<{ authed?: boolean }>(raw ?? "", {
      password: process.env.SESSION_SECRET!,
    });
    authed = data?.authed === true;
  } catch {}
  if (!authed) { ws.close(4401, "Unauthorized"); return; }

  // 2) 경로에서 세션 이름 파싱 + 검증
  const name = req.url?.match(/^\/ws\/([a-zA-Z0-9_-]{1,32})$/)?.[1];
  if (!name) { ws.close(4400, "Bad name"); return; }

  // 3) tmux attach를 PTY로 spawn
  const term = pty.spawn("tmux", ["attach", "-t", name], {
    name: "xterm-256color",
    cols: 120, rows: 40,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: "xterm-256color", LANG: "en_US.UTF-8" },
  });

  term.onData((d) => ws.readyState === ws.OPEN && ws.send(d));
  term.onExit(() => ws.close());

  ws.on("message", (data, isBinary) => {
    if (isBinary) { term.write(data as Buffer); return; }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "resize") term.resize(msg.cols, msg.rows);
    } catch {}
  });

  ws.on("close", () => term.kill());
});
```

---

## 8. 프론트엔드 구조

### 8.1 라우팅 (App Router)

```
app/
├─ layout.tsx              루트 레이아웃 (폰트·테마만)
├─ login/page.tsx          비밀번호 입력 폼 (LNB 없음)
├─ (app)/                  ← 라우트 그룹: LNB 공통 레이아웃을 공유
│  ├─ layout.tsx           LNB (세션 리스트) + 메인 영역 슬롯
│  ├─ page.tsx             / 대시보드 (환영 화면)
│  └─ s/[name]/page.tsx    /s/<n> 터미널 페이지
├─ api/
│  ├─ auth/login/          POST: 비밀번호 검증 + 쿠키 발급
│  ├─ auth/logout/         POST: 쿠키 파기
│  └─ sessions/            REST (list/new/delete)
└─ middleware.ts           인증 가드 (login 제외 전부)
```

### 8.2 `/login` — 로그인 페이지

미들웨어가 미인증 요청을 이 페이지로 리다이렉트하며, 원래 가려던 경로는 쿼리스트링 `?next=...`로 전달해 로그인 후 복귀한다. LNB 없이 중앙 정렬된 단일 카드만 노출.

```
┌────────────────────────────────────────────────────────┐
│                                                        │
│                                                        │
│                ┌──────────────────────┐                │
│                │  Claude Code Web GUI │                │
│                │  ─────────────────── │                │
│                │                      │                │
│                │  비밀번호              │                │
│                │  ┌──────────────────┐│                │
│                │  │ ••••••••••       ││                │
│                │  └──────────────────┘│                │
│                │                      │                │
│                │  ┌──────────────────┐│                │
│                │  │     로그인        ││                │
│                │  └──────────────────┘│                │
│                │                      │                │
│                │  ⚠ 비밀번호가 올바르지  │                │
│                │    않습니다            │                │
│                └──────────────────────┘                │
│                                                        │
└────────────────────────────────────────────────────────┘
```

**동작·상태**

- 인풋 포커스는 마운트 직후 자동 (`autoFocus`).
- 제출 시 버튼 비활성 + 스피너. 응답 대기 중 중복 제출 차단.
- `401`: 인풋 아래 인라인 에러. 비밀번호 필드는 클리어.
- `429`: "너무 많은 시도. 15분 후 다시 시도하세요." 문구로 대체.
- 성공 시 `router.replace(next ?? '/')`.

### 8.3 공통 레이아웃 — LNB + 메인 영역

로그인 이후 모든 화면(`/`, `/s/[name]`)은 동일한 좌측 내비게이션 바(LNB) + 우측 메인 영역 레이아웃을 공유한다. LNB는 `app/(app)/layout.tsx`에서 정의하고, 내부 세션 리스트는 client component + SWR로 10초 폴링한다.

```
┌──────────────────┬─────────────────────────────────────────┐
│ Claude Code      │                                         │
│ Web GUI          │                                         │
│ ────────────     │                                         │
│                  │                                         │
│ ┌──────────────┐ │                                         │
│ │ + 새 세션     │ │                                         │
│ └──────────────┘ │           ← 메인 영역                    │
│                  │           ( / 또는 /s/[name] 렌더링 )    │
│ 활성 세션 (3)     │                                         │
│                  │                                         │
│ ●  my-work     ◀ │                                         │
│     2 windows    │                                         │
│                  │                                         │
│ ○  review-pr-421 │                                         │
│     1 window     │                                         │
│                  │                                         │
│ ○  experiment-rag│                                         │
│     3 windows    │                                         │
│                  │                                         │
│                  │                                         │
│ ────────────     │                                         │
│ [↻ 새로고침]      │                                         │
│ [로그아웃]        │                                         │
└──────────────────┴─────────────────────────────────────────┘
   ↑ 260px 고정                  ↑ 나머지 전체
```

**LNB 구성 요소 (위에서 아래로)**

- **브랜드 영역**: 서비스명. 클릭 시 `/`로.
- **+ 새 세션** 버튼: 클릭 시 인라인 입력 모드로 전환 (§8.3.1 참고). 풀페이지 이동 없이 LNB 안에서 이름 입력 → Enter → 성공 시 해당 세션으로 라우팅.
- **"활성 세션 (N)" 헤더**: 현재 세션 개수.
- **세션 아이템 리스트**:
  - 상태 점: `●` attached / `○` detached
  - 세션 이름 (1줄, 길면 말줄임)
  - 보조 정보: `windows 개수`
  - 현재 보고 있는 세션(`/s/[name]` 페이지의 `name`)은 **하이라이트 + 좌측 마커(◀)** 표시
  - hover 시 우측에 삭제(✕) 아이콘 노출
  - 클릭: `/s/<name>`으로 이동 (Next.js `<Link>` 사용, 메인 영역만 교체)
- **하단 고정 영역**: 새로고침 버튼 + 로그아웃.

**빈 상태**

```
┌──────────────────┐
│ Claude Code      │
│ Web GUI          │
│ ────────────     │
│                  │
│ ┌──────────────┐ │
│ │ + 새 세션     │ │
│ └──────────────┘ │
│                  │
│ 활성 세션 (0)     │
│                  │
│   세션이 없습니다   │
│   버튼을 눌러       │
│   첫 세션을         │
│   만들어 보세요.     │
│                  │
...
```

#### 8.3.1 새 세션 만들기 — 인라인 입력 모드

LNB 버튼을 누르면 그 자리가 인풋으로 바뀐다. 팝업 모달이 아니라 인라인 전개라 흐름이 끊기지 않는다.

```
┌──────────────────┐          ┌──────────────────┐
│ ┌──────────────┐ │          │ ┌──────────────┐ │
│ │ + 새 세션     │ │   클릭→  │ │ 세션 이름     │ │
│ └──────────────┘ │          │ └──────────────┘ │
│                  │          │ [생성] [취소]    │
│ 활성 세션 (3)     │          │ ─────────────    │
│ ...              │          │ 활성 세션 (3)     │
│                  │          │ ...              │
```

- Enter: 제출. Esc: 취소. 빈 문자열이거나 정규식 불일치 시 인풋 테두리 빨강 + 하단 에러 문구.
- 성공 시 `router.push('/s/<new-name>')` + LNB 리스트에 낙관적 추가.
- 실패(409 중복 등) 시 에러 문구 표시하고 인풋 유지.

### 8.4 `/` — 메인 영역 (대시보드)

LNB가 세션 내비게이션을 전담하므로 메인 영역은 환영 화면 + 간단한 통계·안내로 단순화된다.

```
┌──────────────────┬─────────────────────────────────────────┐
│ (LNB)            │                                         │
│                  │   반갑습니다 👋                           │
│ + 새 세션         │                                         │
│                  │   현재 활성 세션 3개가 열려 있어요.         │
│ 활성 세션 (3)     │   왼쪽에서 세션을 선택하거나                │
│ ● my-work      ◀ │   새로 만들어 시작하세요.                   │
│ ○ review-pr-421  │                                         │
│ ○ experiment-rag │   ─────────────────────────             │
│                  │                                         │
│                  │   최근 사용                               │
│                  │   • my-work        2h 전                │
│                  │   • review-pr-421  1d 전                │
│                  │                                         │
│                  │   ─────────────────────────             │
│                  │                                         │
│                  │   💡 팁: 탭을 닫아도 세션은 tmux에         │
│                  │      살아있습니다. 언제든 다시 붙으세요.    │
│                  │                                         │
└──────────────────┴─────────────────────────────────────────┘
```

### 8.5 `/s/[name]` — 터미널 페이지

메인 영역을 xterm 캔버스로 채운다. LNB는 그대로 유지되며, 좌측에서 다른 세션 이름을 클릭하면 메인만 전환된다 (WS 연결은 페이지 전환 시 정리 후 재수립).

```
┌──────────────────┬─────────────────────────────────────────┐
│ (LNB)            │ ●  my-work   120×40   [🔌 재연결]        │
│                  │─────────────────────────────────────────│
│ + 새 세션         │$ claude                                 │
│                  │Welcome to Claude Code.                  │
│ 활성 세션 (3)     │                                         │
│ ● my-work      ◀ │> 지금 프로젝트 구조를 요약해줘              │
│ ○ review-pr-421  │                                         │
│ ○ experiment-rag │I'll take a look at the project...       │
│                  │                                         │
│                  │  src/                                   │
│                  │  ├─ app/                                │
│                  │  ├─ components/                         │
│                  │  └─ lib/                                │
│                  │                                         │
│                  │> █                                      │
│                  │                                         │
│                  │                                         │
│                  │                                         │
└──────────────────┴─────────────────────────────────────────┘
```

**연결 끊김 시**

```
┌──────────────────┬─────────────────────────────────────────┐
│ (LNB)            │ ●  my-work   120×40   [🔌 재연결]        │
│                  │─────────────────────────────────────────│
│ ...              │ ⚠ 연결이 끊어졌습니다. 재연결 중… (2/5) × │
│                  │─────────────────────────────────────────│
│                  │$ claude                                 │
│                  │...                                      │
```

**구성 요소**

- **메인 헤더**: 현재 세션의 상태 점 + 이름 + 크기(`cols×rows`) + 수동 `🔌 재연결` 버튼. (로그아웃과 새로고침은 LNB 하단에 있으므로 여기선 제외)
- **본문**: 헤더 아래 영역을 xterm 캔버스가 모두 차지. `fit` 애드온으로 LNB 폭(260px)을 제외한 공간에 맞춰 `cols×rows` 재계산, 변할 때마다 `{type:"resize"}` 전송.
- **상태 배너 (오버레이)**: 연결 중 / 끊김 / 실패 / 세션 소멸 4가지 상태를 상단에 표시.
- **세션 간 전환**: LNB에서 다른 세션 클릭 → 현재 WS `close()` → 페이지 전환 → 새 세션으로 WS 재수립. xterm 인스턴스는 매 페이지마다 새로 만든다 (메모리 누수 방지).

**키보드·입력**

- 모든 키 입력은 xterm이 가로채 PTY로 전달 (Ctrl-C, Ctrl-D, 방향키, 함수키 포함).
- 브라우저 단축키(Ctrl-W 등)는 브라우저가 우선 처리. "세션은 tmux에 살아있으니 탭을 닫아도 된다"는 점을 LNB 하단이나 빈 영역에 작은 도움말로 표기.
- 붙여넣기: Ctrl-Shift-V 또는 우클릭 컨텍스트 메뉴.

### 8.6 반응형 동작

- **≥1024px**: 위 와이어프레임대로 LNB 고정 노출 (260px).
- **768–1023px (태블릿)**: LNB를 기본 축소 상태로. 햄버거 아이콘으로 토글, 열리면 메인 위에 오버레이.
- **<768px (모바일)**: LNB는 드로어 형태. 터미널은 가로 스크롤 + 읽기 전용 포지셔닝 (§12 참조).

```
(태블릿/모바일 축소 LNB)
┌───┬──────────────────────────────────────┐
│ ☰ │ ●  my-work   120×40   [🔌]           │
├───┼──────────────────────────────────────┤
│   │$ claude                              │
│   │...                                   │
```

### 8.7 공통 UI 원칙

- **다크 테마 기본** — 터미널 가독성 우선.
- **색상 최소화** — 강조색 1개(CTA·현재 세션 하이라이트 전용)만 사용.
- **LNB는 상태 뷰가 아닌 네비게이션** — 세션 상세 편집이나 설정은 LNB가 아닌 모달/메인으로.
- **접근성**: 폼 인풋 label, 버튼 `aria-busy`, 상태 점 `aria-label="연결 중"`, LNB의 현재 세션에 `aria-current="page"`.

---

## 9. 보안

| 위협 | 대응 |
|---|---|
| 외부망 노출 | 사내망 방화벽 내부에 배포. 서비스 포트(3000/3001)를 공인 IP에 바인딩하지 않는다. |
| 무권한 접근 | 공용 비밀번호 + iron-session 암호화 쿠키. 비밀번호 검증은 `crypto.timingSafeEqual`로 상수시간 비교. |
| 비밀번호 브루트포스 | 로그인 엔드포인트에 IP별 5회 실패 → 15분 락 (인메모리). 충분치 않으면 `fail2ban`이나 nginx `limit_req`로 강화. |
| 평문 비밀번호 노출 | `.env` 파일 권한 0600, Git 제외, 서버 접근 인원 최소화. 로그·에러 리포터에 환경변수가 찍히지 않도록 주의 (pino의 redact 옵션 활용). |
| 쉘 인젝션 | 세션 이름 정규식 검증 (`^[a-zA-Z0-9_-]{1,32}$`) + `execFile`로 인자 분리 (shell 미경유). |
| 쿠키 탈취 | `HttpOnly`, `SameSite=Lax`. 사내망 HTTP 사용 시 `Secure=false`로 열지만, 가능하면 사내 CA + TLS 권장. |
| WS 하이재킹 | 동일 오리진 쿠키 기반 인증 + `Origin` 헤더 화이트리스트 검증 (`ws-gateway` 코드 상수). |
| CSRF | 로그인·세션 생성·삭제 API는 `POST`/`DELETE`만 허용, `SameSite=Lax`로 cross-site 자동 전송 차단. |
| 비밀키 유출 | `SESSION_SECRET`, `SHARED_PASSWORD`는 Docker secret 또는 `.env` (권한 0600). Git에는 절대 커밋 금지. |
| 비밀번호 유출 | 비밀번호는 주기적으로 교체(분기 1회 권장). 퇴사자 발생 시 즉시 교체. |
| 감사 추적 | 로그인 시도(성공/실패/IP), 세션 생성·삭제, WS 연결·종료를 구조화 로그로 기록. 단, 개별 사용자 식별은 불가(공용 비밀번호 특성). |
| 권한 남용 | 모든 사용자가 동일 UID로 실행 → 서로의 세션 종료 가능. 개인 식별이 필요해지면 v2에서 사용자별 ID/PW로 전환 검토. |

---

## 10. 배포 & 운영

### 10.1 환경변수

```
# .env  (권한 0600, Git 제외)

# 세션 쿠키 암호화 키 (32자 이상). 회전하면 기존 쿠키 모두 무효화.
# 생성 예: openssl rand -hex 32
SESSION_SECRET=<32바이트 hex>

# 팀 공용 비밀번호 (평문). 분기 1회 회전 권장.
SHARED_PASSWORD=<원하는 비밀번호>

# 파일 뷰어가 노출할 서버 루트 (절대경로). 이 경로 밖은 접근 불가.
# Docker 배포 시에는 보통 /workspace 로 마운트한다.
WORKSPACE_ROOT=/workspace
```

환경변수는 위 3개뿐이다. 나머지는 코드 상수로 관리:

| 값 | 위치 | 이유 |
|---|---|---|
| 세션 유지 기간 (90일) | `lib/session.ts` `SESSION_TTL_SECONDS` | 환경별 차이 없음, 비밀 아님 |
| 로그인 잠금 정책 (5회/15분) | `lib/session.ts` `LOGIN_RATE_LIMIT` | 정책 값, 코드로 관리 |
| 쿠키 이름 | `lib/session.ts` `COOKIE_NAME` | 배포마다 바뀌지 않음 |
| WS 포트 (3001) | `ws-gateway/index.ts` 상수 | 사실상 고정 |
| 허용 Origin 리스트 | `ws-gateway/index.ts` 배열 상수 | 서버 이전 시에만 수정 |

> **비밀번호 회전 절차**: `.env`의 `SHARED_PASSWORD` 값을 변경 → `docker compose restart` → 팀에 새 비밀번호 공유. 기존 로그인 세션은 유지되므로 서비스 중단 없음.
> **전원 강제 로그아웃**: `SESSION_SECRET`도 함께 교체 후 재시작.

### 10.2 Docker Compose (개요)

```yaml
services:
  ui:
    build: ./ui                 # Next.js 16.2
    env_file: .env
    ports: ["3000:3000"]        # 브라우저가 <서버IP>:3000 으로 직접 접근
    volumes:
      - /tmp/tmux-1000:/tmp/tmux-1000   # tmux 소켓 공유
      - /Users/sigmine/projects:/workspace:ro   # 파일 뷰어가 읽을 루트 (:ro 필수)
  ws:
    build: ./ws-gateway
    env_file: .env
    ports: ["3001:3001"]        # 브라우저가 ws://<서버IP>:3001 으로 접근
    volumes:
      - /tmp/tmux-1000:/tmp/tmux-1000
  # nginx는 선택. 포트를 하나로 합치거나 rate limit을 걸고 싶을 때 추가.
  # nginx:
  #   image: nginx:1.27
  #   ports: ["80:80"]
  #   volumes:
  #     - ./nginx.conf:/etc/nginx/nginx.conf:ro
  #   depends_on: [ui, ws]
```

`ui`와 `ws` 컨테이너는 같은 tmux 소켓(`/tmp/tmux-*`)에 접근해야 하므로 볼륨 공유 필요. 호스트에서 이미 tmux를 실행 중이라면 그 소켓 경로를 양쪽 컨테이너에 마운트한다. 또는 단순히 host network 모드 + 동일 UID로 운용해도 된다.

> **포트 설계 요약**
> - 최소 구성: 3000(UI), 3001(WS) 두 개를 방화벽에서 사내망에만 노출.
> - nginx 추가 시: 80 하나만 노출하고 내부에서 3000/3001로 프록시.

### 10.3 모니터링

- `/api/health` 엔드포인트 (tmux 명령 응답 여부 체크).
- WS 활성 연결 수, 세션 개수를 Prometheus로 노출 (선택).
- 로그 파일 로테이션: logrotate 또는 pino-roll.

---

## 11. 마일스톤

| 주차 | 목표 |
|---|---|
| W1 | Next.js 16.2 스캐폴딩, 공용 비밀번호 로그인 + iron-session, 미들웨어 가드 |
| W2 | REST API (list/new/delete), 세션 리스트 UI, 신규 생성 플로우 |
| W3 | WS 게이트웨이 + node-pty, xterm 페이지, 리사이즈/재연결 |
| W4 | Docker Compose 배포, 감사 로그, 보안 점검, 사내 오픈베타 |
| 이후 | 사용자별 ID/PW 전환 (감사 추적 강화), 사용자별 tmux 소켓 분리, 세션 북마크 등 |

---

## 12. 파일 뷰어 (v0.5)

### 12.1 개요

- 서버의 **고정 루트** 한 곳(`WORKSPACE_ROOT`, 예: `/workspace`)을 웹에서 VS Code 파일 탐색기처럼 열람한다.
- **수정·삭제·디렉터리 생성은 불가**, **신규 파일 업로드만 허용**한다. 기존 파일은 절대 덮어쓰지 않으며, 같은 이름이 있으면 `name (1).ext` 형태로 자동 리네임. 업로드용 `POST /api/fs/upload` 외에 쓰기 API는 없다. Docker 배포 시 워크스페이스 볼륨은 `:rw`로 마운트한다(과거 v0.5의 `:ro`에서 변경).
- 탐색기 화면은 tmux 세션과 분리된 독립 페이지(`/files`)로 제공한다. 세션별 cwd 연동은 하지 않는다 — "지금 열린 세션과 무관하게 언제든 프로젝트 파일을 뒤져보는" 용도.
- 파일 한 개 또는 폴더 통째를 다운로드할 수 있다. 폴더는 zip으로 on-the-fly 생성.
- 파일 변경은 SSE로 실시간 반영한다. Claude Code가 tmux에서 파일을 수정하면 트리와 뷰어가 자동 갱신된다.

### 12.2 라우팅 & 컴포넌트

```
app/
├─ (app)/files/
│  ├─ page.tsx                 /files — 트리 + 뷰어 + 브레드크럼 (client component)
│  └─ _components/
│     ├─ FileTree.tsx          재귀 트리. 폴더 클릭 시 lazy fetch + watch 구독
│     ├─ FileViewer.tsx        Monaco(read-only). dynamic import로 /files 진입 시에만 로드
│     ├─ ImageViewer.tsx       이미지 프리뷰
│     └─ Breadcrumb.tsx        경로 + 복사 버튼
├─ api/fs/
│  ├─ tree/route.ts            GET ?path=relative  → 디렉터리 직속 자식
│  ├─ file/route.ts            GET ?path=relative  → 텍스트/바이너리 스트림
│  ├─ download/route.ts        GET ?path=relative  → 파일/zip 스트림 (폴더면 자동 zip)
│  ├─ upload/route.ts          POST multipart      → 지정 폴더에 파일 업로드 (충돌 시 자동 리네임)
│  └─ watch/route.ts           GET (SSE)           → 구독 경로 변경 이벤트 스트림
└─ lib/fs/
   ├─ guard.ts                 경로 정규화 + 루트 prefix 검증
   └─ watcher.ts               SSE 커넥션별 on-demand 구독 관리자
```

LNB 하단에 `📁 파일` 링크 하나를 추가한다. 클릭 시 `/files`로 이동.

### 12.3 API 스펙

**GET /api/fs/tree?path=\<relative\>**

```jsonc
// 200
{
  "path": "src/app",
  "entries": [
    { "name": "page.tsx", "type": "file",   "size": 1532, "mtime": 1714012345 },
    { "name": "api",      "type": "dir",    "size": 0,    "mtime": 1714012300 },
    { "name": "link.txt", "type": "symlink" }              // lstat만, 따라가지 않음
  ]
}
```

- `path` 누락 시 루트(`""`) 기준.
- 정렬: 폴더 먼저, 이름 사전순.
- 숨김 파일(dotfiles)도 그대로 반환. UI 토글은 프론트 단에서 처리.

**GET /api/fs/file?path=\<relative\>**

- `stat.size > 2MB` 또는 바이너리(null byte 포함)면 `413 Payload Too Large` + `{ "reason": "too_large" | "binary", "size": 12345, "mime": "..." }` JSON. UI는 이 경우 "미리보기 없음 + 다운로드" 버튼만 노출.
- 텍스트/이미지는 `Content-Type` 적절히 세팅 후 스트림 응답.
- 디렉터리면 `400 Bad Request`.

**GET /api/fs/download?path=\<relative\>**

- 파일: `Content-Disposition: attachment; filename="..."` 헤더와 함께 스트림.
- 폴더: `archiver`로 zip 스트리밍. 파일명은 `<basename>.zip`.
- 루트(`path=""`)도 허용 — 프론트에서 "전체 다운로드는 용량이 큽니다" 경고 모달 후 진행.

**POST /api/fs/upload** (`multipart/form-data`)

- 폼 필드: `path` = 대상 디렉터리(루트는 `""`), `file` = 업로드 파일(여러 개 허용).
- 디렉터리가 아니거나 루트 밖(`..`/심링크) → `400`/`403`.
- 동명 파일 존재 시 `name (1).ext`, `name (2).ext` ... 로 자동 리네임. 절대 덮어쓰지 않음.
- 응답: `201 { ok: true, target: "rel/dir", files: [{ name, size, path }] }`.
- 클라이언트는 LNB 파일 트리에 **드래그 앤 드롭** 또는 툴바의 **⬆ 버튼**(파일 선택)으로 호출. 드롭 위치 우선순위:
  1. 폴더 노드에 드롭 → 그 폴더
  2. 파일 노드에 드롭 → 파일의 부모 폴더
  3. 영역 배경에 드롭 → 현재 선택된 파일의 부모, 없으면 루트
- 업로드된 파일은 원자적으로(`tmp` → `rename`) 기록한다.

**GET /api/fs/watch (Server-Sent Events)**

- 한 클라이언트당 EventSource 하나를 연다. 프론트는 폴더를 펼치거나 파일을 열 때마다 별도 `POST /api/fs/watch/subscribe?conn=<id>&path=<p>`로 구독 경로를 추가한다.
  - 단순화 대안: 쿼리 파라미터가 아닌 **같은 SSE 커넥션에 대한 다음 요청으로 body를 보낼 수 없으므로**, 클라이언트가 상태를 들고 있다가 매 구독 변화마다 fetch로 관리자 API에 알린다. `conn` id는 서버가 SSE 열릴 때 첫 이벤트로 교부.
- 이벤트 포맷:
  ```
  event: hello
  data: {"conn":"c_abcd1234"}

  event: change
  data: {"type":"add","path":"src/new.ts"}

  event: change
  data: {"type":"unlink","path":"src/old.ts"}
  ```
- `change.type ∈ {add, addDir, unlink, unlinkDir, change}` (chokidar 이벤트 그대로 pass-through).
- 서버는 SSE가 끊기면 해당 `conn`의 모든 watcher를 해제한다.

### 12.4 on-demand 워치 전략

차단 패턴이 없기 때문에 `node_modules` 같은 거대 트리까지 기본 감시하면 프로세스가 무거워진다. 해결:

- 클라이언트가 **폴더를 펼칠 때만** 해당 경로를 `depth: 0`(직속 자식만)으로 watch.
- 폴더를 접거나 다른 경로로 이동하면 watcher 해제.
- 현재 열린 파일은 파일 단위 개별 구독.
- 서버에 `Map<connId, Map<path, FSWatcher>>` 유지. 커넥션 종료 시 전부 close.
- 초기 진입(루트 트리 첫 로드) 시 루트 한 레벨만 자동 구독.

### 12.5 보안

- **경로 정규화**: `const abs = path.resolve(ROOT, userPath); if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) → 403`
- **심볼릭 링크**: `fs.lstat`로 확인. 심링크는 메타 노출만 하고 실제 접근(read/tree/download)은 거부.
- **쉘 미사용**: 모든 FS 작업은 `node:fs/promises` API로. `execFile`조차 사용 안 함.
- **쓰기 범위 제한**: `/api/fs/upload` 외에는 쓰기 메서드(PUT/DELETE/PATCH) 구현 없음. 업로드는 항상 신규 파일 생성만 하며 기존 파일은 자동 리네임으로 보존한다(덮어쓰기 불가). Docker 볼륨은 `:rw`이지만, 워크스페이스 권한 자체를 컨테이너 사용자에게만 허용해 호스트의 다른 경로 노출은 차단한다.
- **인증**: 기존 `isAuthed()` 가드를 모든 `/api/fs/*`에 적용. SSE도 쿠키 기반 동일 검증.
- **경로 쿼리 검증**: 쿼리 파라미터 `path`는 빈 문자열 허용(루트), 그 외엔 `..` 정규화 후 prefix 검증으로만 통과.

### 12.6 레이아웃

```
┌──────────┬────────────────────────────────────────────────┐
│ LNB      │ 📁 projects  >  claude-code-web-gui  >  spec.md│
│          │────────────────────────────────────────────────│
│ + 새 세션│ ┌──────────────┬─────────────────────────────┐ │
│          │ │ ▾ claude-... │  (Monaco read-only)         │ │
│ ● my-work│ │   ▾ ui       │                             │ │
│          │ │     ▾ app    │  # Claude Code Web GUI ...  │ │
│ ──────   │ │       page...│                             │ │
│ 📁 파일  │ │   ▸ ws-gate..│                             │ │
│          │ │   spec.md ◀  │  [⬇ 다운로드] [📋 경로]     │ │
│ [로그아웃]│ │ ▸ edu-sigmine│                             │ │
│          │ └──────────────┴─────────────────────────────┘ │
└──────────┴────────────────────────────────────────────────┘
  260px       트리 280px        뷰어 남은 전체
```

- LNB는 기존 그대로, 하단 "📁 파일" 링크만 추가.
- 트리: 폴더 아이콘(▸ 접힘 / ▾ 펼침) + 이름. 현재 선택된 파일 하이라이트 + 좌측 마커(`◀`).
- 뷰어 영역:
  - 텍스트: Monaco(read-only). 언어는 확장자 기반 자동 추론.
  - 이미지: `<img>` 중앙 정렬.
  - 바이너리/대용량: "미리보기 없음" 안내 + `⬇ 다운로드` 버튼만.
- 상단 브레드크럼: 조각마다 클릭 가능. 맨 끝은 현재 파일명.

### 12.7 의존성

| 패키지 | 용도 |
|---|---|
| `@monaco-editor/react` | 텍스트 뷰어 (VS Code 에디터 코어). dynamic import로 /files에서만 로드 |
| `archiver` | 폴더 zip 스트리밍 |
| `chokidar` | 파일 워처 |
| `mime-types` | Content-Type 추정 |

Monaco는 번들 사이즈가 크므로(3MB+) `next/dynamic`으로 분리해 다른 페이지 성능에 영향을 주지 않는다.

### 12.8 환경변수

`.env.example`에 추가:

```
# 파일 뷰어가 노출할 서버 루트 디렉터리 (절대경로).
# 이 경로 밖은 API·UI 모두 접근 불가.
WORKSPACE_ROOT=/workspace
```

Docker Compose에는 호스트 projects 디렉터리를 `/workspace`로 **읽기 전용** 마운트:

```yaml
services:
  ui:
    volumes:
      - /Users/sigmine/projects:/workspace        # 업로드를 위해 :rw 마운트 (호스트 경로에 맞게)
```

로컬 개발(컨테이너 X)에선 `.env`에 `WORKSPACE_ROOT=/Users/sigmine/projects` 같은 실경로를 그대로 쓴다.

---

## 13. 열린 이슈

- **다중 호스트 확장**: 현재는 단일 서버 전제. tmux 세션을 여러 머신에 분산하려면 호스트 선택 UI + 라우팅 필요.
- **동시 attach**: 두 브라우저가 같은 세션에 붙으면 tmux 기본 동작상 화면이 링크된다. `-d` 옵션으로 기존 연결을 끊을지 UI에서 선택하게 할지 결정 필요.
- **Claude Code 자동 실행**: 새 세션 생성 시 `tmux new-session -d -s <name> 'claude'` 형태로 명령을 바로 띄울지 여부. 1차 릴리스는 빈 셸, v2에서 옵션화.
- **모바일 지원**: xterm.js의 가상 키보드 경험이 제한적. 모바일은 "읽기 전용 모니터링"으로 포지셔닝.
- **개별 사용자 식별**: 공용 비밀번호 모델은 "누가 무엇을 했는지" 추적이 불가. 감사 요구가 생기면 사용자별 ID/PW 또는 사내 SSO로 전환. API/쿠키 포맷은 동일하게 유지할 수 있도록 인증 레이어를 분리해 설계.
- **TLS 적용 시점**: 사내망 HTTP로 시작하지만, 패킷 캡처 우려나 규정 이슈가 있으면 사내 CA + nginx TLS 종단을 추가. `cookieOptions.secure = true`로 전환 필요.