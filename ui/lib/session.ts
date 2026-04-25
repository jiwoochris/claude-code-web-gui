import type { SessionOptions } from "iron-session";

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 90;
export const LOGIN_RATE_LIMIT = { maxAttempts: 5, lockMinutes: 15 };
export const COOKIE_NAME = "claude_gui_session";
export const SESSION_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

export interface SessionData {
  authed?: true;
  issuedAt?: number;
}

export const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET ?? "",
  cookieName: COOKIE_NAME,
  ttl: SESSION_TTL_SECONDS,
  cookieOptions: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: SESSION_TTL_SECONDS,
  },
};
