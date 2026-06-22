/**
 * Per-user config file stored at ~/.config/eac/config.json.
 *
 * Holds the user profile (SAP fields) and reimbursement line presets so that
 * `eac voucher create --item "자기관리비" ...` doesn't require re-entering
 * PERNR/KOSTL/HKONT/결재선 every time.
 */

import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { UserProfile, ReimbursementItem } from "../types/index.ts";

const CONFIG_DIR = join(homedir(), ".config", "eac");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface EacConfig {
  user: UserProfile;
  items: Record<string, ReimbursementItem>; // key = preset name, e.g. "자기관리비"
}

async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
}

export async function loadConfig(): Promise<EacConfig | null> {
  try {
    const content = await readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(content) as EacConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(cfg: EacConfig): Promise<void> {
  await ensureConfigDir();
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

export function configPath(): string {
  return CONFIG_FILE;
}

/**
 * Shipped defaults for the current user (박영걸/ZB01135) so the CLI works out of the box.
 * Override via `eac config` or by editing ~/.config/eac/config.json.
 */
export const DEFAULT_CONFIG: EacConfig = {
  user: {
    pernr: "ZB01135",
    bukrs: "K001",
    pernrName: "박영걸",
    wfIdText: "YG Park (박영걸)",
    kostl: "226020",
    kostlText: "Device Engineering",
    gsber: "K200", // 사업영역 — 비용센터와 일치시킬 것 (e.g. kostl 343000 → "K300")
    wfDept: "0000252100",
    wfDeptText: "Service Engineering",
  },
  items: {
    "자기관리비": {
      hkont: "52010108",
      hkontText: "판)복리후생비-자기관리비",
      evikb: "FI_21",
      evikbText: "장려지원금",
      wfLineSeq: "0000000002",
      wfLineLin1: "0000000816",
    },
    "법인카드": {
      // hkont here is a placeholder — corpcard create takes --hkont per transaction.
      // For request-approval the row's stored HKONT is what counts; this entry just
      // carries EVIKB/wfLineSeq for the WF flow.
      hkont: "52010102",
      hkontText: "판)복리후생비-회식대",
      evikb: "FI_12",
      evikbText: "법인카드기명식",
      wfLineSeq: "0000000004",
      wfLineLin1: "0000000924",
    },
  },
};
