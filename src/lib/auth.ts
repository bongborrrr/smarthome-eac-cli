/**
 * macOS Chromium cookie store → JSESSIONID extraction.
 * AES-128-CBC decrypt with key derived from the browser's "<X> Safe Storage" keychain password.
 *
 * Chromium-family browsers (Chrome, Comet, Brave, Edge) store cookies identically on macOS;
 * only the cookie DB path and the keychain service name differ. Select with EAC_BROWSER
 * (default: chrome).
 *
 * EAC uses Google SSO + MS Azure AD SAML chain. The login itself can't be automated
 * (2FA/SSO), so when the session is missing/expired we open the browser at the EAC URL,
 * wait for the user to finish login, then re-read the cookie.
 */

import { Database } from "bun:sqlite";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { copyFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { AuthError } from "./errors.ts";

const HOST_PATTERN = "%zigbang.in%";
const COOKIE_NAME = "JSESSIONID";

/**
 * A Chromium-family browser on macOS. The crypto (PBKDF2 salt=saltysalt/1003/16B →
 * AES-128-CBC, 32-byte hash prefix strip) is identical across all of them — only the
 * cookie path and keychain service name differ.
 */
interface BrowserProfile {
  /** Display name, also the `open -a` target. */
  name: string;
  /** Cookies SQLite path. */
  cookies: string;
  /** Keychain "<X> Safe Storage" service holding the master key. */
  keychain: string;
}

const BROWSERS: Record<string, BrowserProfile> = {
  chrome: {
    name: "Google Chrome",
    cookies: join(homedir(), "Library/Application Support/Google/Chrome/Default/Cookies"),
    keychain: "Chrome Safe Storage",
  },
  comet: {
    name: "Comet",
    cookies: join(homedir(), "Library/Application Support/Comet/Default/Cookies"),
    keychain: "Comet Safe Storage",
  },
  brave: {
    name: "Brave Browser",
    cookies: join(homedir(), "Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies"),
    keychain: "Brave Safe Storage",
  },
  edge: {
    name: "Microsoft Edge",
    cookies: join(homedir(), "Library/Application Support/Microsoft Edge/Default/Cookies"),
    keychain: "Microsoft Edge Safe Storage",
  },
};

/** Browser selected via EAC_BROWSER (default: chrome). Throws on an unknown value. */
function selectedBrowser(): BrowserProfile {
  const key = (process.env.EAC_BROWSER ?? "chrome").toLowerCase();
  const b = BROWSERS[key];
  if (!b) {
    throw new AuthError(
      `Unknown EAC_BROWSER="${key}". Supported: ${Object.keys(BROWSERS).join(", ")}.`,
    );
  }
  return b;
}

function getMasterKey(browser: BrowserProfile): Buffer {
  let out: string;
  try {
    out = execSync(`security find-generic-password -s "${browser.keychain}" -g 2>&1`, { encoding: "utf-8" });
  } catch (e: any) {
    throw new AuthError(`${browser.keychain} keychain read failed: ${e?.message ?? e}`);
  }
  const pw = out.match(/password:\s*"([^"]+)"/)?.[1];
  if (!pw) throw new AuthError(`${browser.keychain} keychain password not found`);
  return pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
}

function decryptCookie(encrypted: Buffer, key: Buffer): string {
  if (!encrypted?.length) return "";
  const prefix = encrypted.subarray(0, 3).toString("utf-8");
  // No version prefix → value is stored unencrypted; return as-is.
  if (prefix !== "v10" && prefix !== "v11") return encrypted.toString("utf-8");
  const iv = Buffer.from(" ".repeat(16), "utf-8");
  const d = createDecipheriv("aes-128-cbc", key, iv);
  d.setAutoPadding(false);
  const out = Buffer.concat([d.update(encrypted.subarray(3)), d.final()]);
  const pad = out[out.length - 1]!;
  const unpadded = pad > 0 && pad <= 16 ? out.subarray(0, out.length - pad) : out;
  // Chromium v10/v11 values on macOS prefix a 32-byte sha256 hash of (host + name); strip it.
  return unpadded.subarray(32).toString("utf-8");
}

export function extractJSESSIONID(browser: BrowserProfile = selectedBrowser()): string {
  const tmp = join(tmpdir(), `eac-${Date.now()}.db`);
  copyFileSync(browser.cookies, tmp);
  try {
    const key = getMasterKey(browser);
    const db = new Database(tmp, { readonly: true });
    const row = db
      .query<{ encrypted_value: Buffer }, [string, string]>(
        "SELECT encrypted_value FROM cookies WHERE host_key LIKE ? AND name = ? LIMIT 1",
      )
      .get(HOST_PATTERN, COOKIE_NAME);
    db.close();
    if (!row) {
      throw new AuthError(
        `JSESSIONID not found in ${browser.name} cookies — log in to eac.zigbang.in in ${browser.name}`,
      );
    }
    return decryptCookie(Buffer.from(row.encrypted_value), key);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

const EAC_URL = "https://eac.zigbang.in/unidocu/view.do";

/** Returns true if the JSESSIONID is accepted by EAC (server returns the SPA HTML, not a redirect to login). */
export async function isSessionAlive(jsessionid: string): Promise<boolean> {
  if (!jsessionid) return false;
  try {
    const r = await fetch(EAC_URL, {
      method: "GET",
      headers: { Cookie: `JSESSIONID=${jsessionid}` },
      redirect: "manual",
    });
    // 200 = logged in (SPA shell). 302 redirect to /oAuth/googleLogin = expired.
    return r.status === 200;
  } catch {
    return false;
  }
}

function openBrowserAtEac(browser: BrowserProfile): void {
  // `open -a "<Browser>" <url>` reuses an existing window/profile.
  spawn("open", ["-a", browser.name, EAC_URL], { stdio: "ignore", detached: true }).unref();
}

async function waitForEnter(): Promise<void> {
  process.stderr.write("로그인 완료 후 Enter를 눌러주세요... ");
  for await (const _ of process.stdin) break;
  process.stderr.write("\n");
}

/** Try to extract the cookie; if missing or expired, open the browser and wait for the user. */
export async function ensureSession(): Promise<string> {
  // 1) env override always wins.
  const envToken = process.env.EAC_JSESSIONID;
  if (envToken) {
    if (await isSessionAlive(envToken)) return envToken;
    throw new AuthError("EAC_JSESSIONID is set but the session is not valid (expired or wrong cookie).");
  }

  const browser = selectedBrowser();

  // 2) Try the browser keychain first. Quietly swallow "cookie not present yet" — that's the
  //    expected state when the user has never logged in to EAC in this browser.
  let token = "";
  try { token = extractJSESSIONID(browser); } catch { token = ""; }
  if (token && await isSessionAlive(token)) return token;

  // 3) Need a (re-)login. Tell the user, open the browser, wait, then re-read.
  if (!process.stdin.isTTY) {
    throw new AuthError(
      `EAC session missing/expired and stdin is not a TTY — log in to eac.zigbang.in in ${browser.name} and re-run, or pass EAC_JSESSIONID.`,
    );
  }
  process.stderr.write(token
    ? `EAC 세션 만료됨. ${browser.name}에서 다시 로그인 필요.\n`
    : `EAC 세션 없음. ${browser.name}에서 로그인 필요.\n`);
  process.stderr.write([
    "",
    "  순서:",
    `    1. 열린 ${browser.name}에서 SSO 로그인을 끝낸다.`,
    `    2. ${browser.name}을 한 번 종료(Cmd+Q)한다.  ← 디스크에 cookie flush`,
    "       (안 끄면 새 JSESSIONID가 메모리에만 남아 CLI가 못 읽는다.)",
    "    3. 여기로 돌아와 Enter를 누른다.",
    `    4. 작업 끝나면 ${browser.name} 다시 켜서 평소대로 사용.`,
    "",
    `  팁: ${browser.name} 설정 > 시작할 때 > '중단한 곳에서 계속하기'를 켜면,`,
    "      종료해도 session cookie가 유지돼서 다음번 EAC 재로그인이 줄어든다.",
    "",
  ].join("\n"));
  openBrowserAtEac(browser);
  await waitForEnter();

  token = extractJSESSIONID(browser);
  if (!await isSessionAlive(token)) {
    throw new AuthError(
      `로그인이 확인되지 않았습니다. ${browser.name}에서 eac.zigbang.in에 정상 로그인했는지 확인 후 다시 시도하세요.`,
    );
  }
  return token;
}
