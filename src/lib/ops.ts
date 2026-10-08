/**
 * High-level operations on EAC (UniDocu). Each function wraps one or more
 * named-service calls. CLI commands are thin shims over these.
 *
 * Domain model
 * ------------
 * UniDocu exposes two related document spaces and two separate attachment layers:
 *
 *   전표 (FI)        : SAP 문서 (BELNR). Menu UD_0302_000. Services ZUNIEFI_*.
 *   결재문서 (WF)     : 결재 워크플로우 객체 (GRONO, WF_KEY). Menu UFL_0401_*.
 *                      Services ZUNIEWF_*.
 *
 * A voucher (전표) becomes an approval doc (결재문서) by being request-approval'd:
 * that step reserves a GRONO on the voucher and submits it into a 결재함.
 *
 * Attachment layers (same receipt file, uploaded to *both* layers):
 *
 *   전표 레이어      : bound at ZUNIEFI_4006 via EVI_SEQ. Accountants see it in
 *                      the 전표 상세 view.
 *   결재문서 레이어   : passed as EVI_SEQ in the final ApprovalStep body. THIS is
 *                      what flips WF_ATTACH_FLAG=X on the 결재함 list (approvers'
 *                      📎 icon). Without this layer the approval doc looks empty
 *                      to approvers even though the voucher has files.
 *
 * Stage boundaries
 * ----------------
 *   createTempDoc     → Steps 1-5 (ZUNIEFI_4003/ECM_5030/uploader/EFI_4006/EFI_5000)
 *                       yields { belnr, eviSeqEa, zfbdt }
 *   reserveGrono      → Step 6  (ZUNIEFI_4203) — GRONO 예약, not yet submitted
 *   submitApproval    → Steps 7-11 (ECM_5030/uploader/WF_2200/WF_4101/ApprovalStep)
 *
 * No composite "do all 11 at once" helper is exposed on purpose: failures
 * between stages produce visible, recoverable state (e.g. a dangling BELNR
 * without GRONO can be retried via request-approval rather than started over).
 */

import { callNS, uploadFile as uploadFileRaw, listSession, type ClientContext, type SessionFile } from "./client.ts";
import type { ApprovalLine, UserProfile, ReimbursementItem } from "../types/index.ts";
import { ApiError } from "./errors.ts";

/* ── Program IDs — mirror UniDocu menu codes ───────────────────────── */

/** 비용정산 > 개인비용 (EA 전표) */
export const PROG_EA_MENU = "UD_0302_000";
/** 결재요청 폼 (결재문서 첨부 레이어) */
export const PROG_DRAFT = "DRAFT_0010";
/** 결재문서 조회/회수 뷰어 */
export const PROG_VIEWER = "DRAFT_0011";
/** 장려지원금 전용 메뉴 (과거, 4003/4006/5000이 이것 기대) */
export const PROG_LEGACY = "ZB_0202_001";
/** 법인카드(공용) 사용내역 조회 */
export const PROG_CORPCARD_LIST = "UD_0201_000";
/** 법인카드(공용) 정산 폼 */
export const PROG_CORPCARD_FORM = "UD_0201_001";

/** 진행함/결재함 program IDs → DISPLAY_GB mapping */
export const APPROVAL_BOXES = {
  pending:  { prog: "UFL_0401_010", gb: "A", label: "미처리" },
  progress: { prog: "UFL_0401_020", gb: "D", label: "진행중" },
  rejected: { prog: "UFL_0401_030", gb: "C", label: "반려/회수" },
  approved: { prog: "UFL_0401_040", gb: "B", label: "승인" },
} as const;
export type ApprovalBox = keyof typeof APPROVAL_BOXES;

/* ── Attachments (fineuploader EVI_SEQ layer) ──────────────────────── */

/** Reserve a new EVI_SEQ via ZUNIECM_5030. The returned sequence is scoped to
 *  the program ID: the EA-전표 layer and the 결재문서 (DRAFT_0010) layer use
 *  independent pools. */
export async function createAttachSeq(ctx: ClientContext, programId: string): Promise<string> {
  const r = await callNS(ctx, "ZUNIECM_5030", programId, { tableParamsString: "{}" });
  const seq = r?.NSReturn?.stringReturns?.O_EVI_SEQ ?? "";
  if (!seq) throw new ApiError("ZUNIECM_5030", 200, "O_EVI_SEQ not returned", JSON.stringify(r));
  return seq;
}

export async function uploadAttachment(ctx: ClientContext, eviSeq: string, filePath: string): Promise<void> {
  await uploadFileRaw(ctx, eviSeq, filePath);
}

export async function uploadAttachments(ctx: ClientContext, eviSeq: string, filePaths: string[]): Promise<void> {
  for (const p of filePaths) await uploadFileRaw(ctx, eviSeq, p);
}

export async function listAttachments(ctx: ClientContext, eviSeq: string): Promise<SessionFile[]> {
  return await listSession(ctx, eviSeq);
}

/* ── EA 전표 (임시전표) — UD_0302_000 grid ─────────────────────────── */

export interface TempDocRow {
  GRONO: string;
  BELNR: string;
  DOKNR: string;
  EVI_SEQ: string;
  BUDAT: string;
  BLDAT: string;
  ZFBDT: string;
  WRBTR: string;
  DMBTR: string;
  WAERS: string;
  SGTXT: string;
  BSTAT: string;
  BSTAT_TXT: string;
  STATS: string;
  STATS_TXT: string;
  BLART: string;
  BLART_TXT: string;
  EVIKB: string;
  EVIKB_TXT: string;
  LIFNR: string;
  LIFNR_TXT: string;
  PERNR: string;
  PERNR_TXT: string;
  KOSTL: string;
  KOSTL_TXT: string;
  HKONT: string;
  HKONT_TXT: string;
  GJAHR: string;
  BUKRS: string;
  [k: string]: string;
}

export interface TempListFilter {
  from: string;          // YYYYMMDD (BUDAT_FR)
  to: string;            // YYYYMMDD (BUDAT_TO)
  bstat?: string;        // "V" | "*" — default "*"
  stats?: string;        // "" | "C" | "R" | "2" | "4" | "*" — default "*"
  evikb?: string;
  belnr?: string;
}

export async function listTempDocs(ctx: ClientContext, filter: TempListFilter, user: UserProfile): Promise<TempDocRow[]> {
  const r = await callNS(ctx, "ZUNIEFI_4200", PROG_EA_MENU, {
    BUDAT_FR: filter.from, BUDAT_TO: filter.to,
    EVIKB: filter.evikb ?? "",
    PERNR: user.pernr, PERNR_TXT: user.pernrName,
    BSTAT: filter.bstat ?? "*",
    STATS: filter.stats ?? "*",
    BELNR: filter.belnr ?? "",
    BUKRS: user.bukrs,
    tableParamsString: "{}",
  });
  return (r?.NSReturn?.tableReturns?.OT_DATA as TempDocRow[] | undefined) ?? [];
}

/** 그룹번호취소 — releases the GRONO from a 회수(recalled) temp doc so it can be
 *  re-submitted. Sends the whole row fields back to ZUNIEFI_4202 with STATS=C. */
export async function cancelTempDocGroup(ctx: ClientContext, row: TempDocRow): Promise<void> {
  const fields: Record<string, string> = {};
  for (const k of Object.keys(row)) {
    const v = (row as any)[k];
    if (v == null) continue;
    fields[k] = String(v);
  }
  fields.SELECTED = "1";
  fields.STATS = "C";
  fields.tableParamsString = "{}";
  await callNS(ctx, "ZUNIEFI_4202", PROG_EA_MENU, fields);
}

/** 임시전표삭제 — wipes the BELNR entirely. Resolved at runtime via UI as
 *  `$u.programSetting.getValue('deleteStatementMultiRFC')` = `ZUNIEFI_4103`.
 *  Use case: after a 반려, you `cancel-group` to drop the GRONO, then `delete`
 *  the BELNR so the underlying card transaction (or the source line) reappears
 *  in the unprocessed list and can be re-posted with corrected fields (e.g.
 *  HKONT). The voucher row must already be detached from any GRONO; the server
 *  will reject the call otherwise. */
export async function deleteTempDoc(ctx: ClientContext, row: TempDocRow): Promise<void> {
  await callNS(ctx, "ZUNIEFI_4103", PROG_EA_MENU, {
    tableParamsString: JSON.stringify({ IT_DATA: [row] }),
  });
}

/* ── 결재문서 (ZUNIEWF_4500 grid) ──────────────────────────────────── */

export interface ApprovalDocRow {
  GRONO: string;
  WF_KEY: string;
  WF_KEY_TEXT: string;
  WF_TITLE: string;
  WF_DATE: string;
  WF_TIME: string;
  WF_AMOUNT: string;
  WF_STATUS: string;
  WF_STATUS_TXT: string;
  WF_ATTACH_FLAG: string;
  WF_TYPE: string;
  WF_GB: string;
  EVIKB: string;
  EVIKB_TXT: string;
  WF_DEPT: string;
  WF_DEPT_TXT: string;
  WF_ID: string;
  WF_ID_TXT: string;
  PERNR: string;
  KOSTL: string;
  BUKRS: string;
  GJAHR: string;
  WF_SECUR: string;
  [k: string]: string;
}

export interface DocListFilter {
  from: string;
  to: string;
  evikb?: string;
  title?: string;
}

export async function listApprovalDocs(
  ctx: ClientContext,
  box: ApprovalBox,
  filter: DocListFilter,
): Promise<ApprovalDocRow[]> {
  const b = APPROVAL_BOXES[box];
  const r = await callNS(ctx, "ZUNIEWF_4500", b.prog, {
    ST_DATE_FR: filter.from, ST_DATE_TO: filter.to,
    EVIKB: filter.evikb ?? "",
    WF_ID: "", WF_ID_TXT: "", WF_GB: "",
    WF_TITLE: filter.title ?? "",
    DISPLAY_GB: b.gb,
    tableParamsString: "{}",
  });
  return (r?.NSReturn?.tableReturns?.OT_DATA as ApprovalDocRow[] | undefined) ?? [];
}

/** Returns 4207 response including the `URL` which carries the attachment fileGroupId. */
export async function showApprovalDoc(ctx: ClientContext, grono: string): Promise<any> {
  const r = await callNS(ctx, "ZUNIEFI_4207", PROG_DRAFT, { GRONO: grono, tableParamsString: "{}" });
  return r?.NSReturn?.tableReturns?.OT_DATA1?.[0] ?? null;
}

/** Extract the attachment EVI_SEQ (fileGroupId) from a ZUNIEFI_4207 response URL. */
export function parseFileGroupIdFromUrl(url: string): string | null {
  return url.match(/fileGroupId=([^&]+)/)?.[1] ?? null;
}

/** Look up one approval doc row (used to drive recall, which needs the whole row). */
export async function findApprovalDoc(
  ctx: ClientContext,
  grono: string,
  box: ApprovalBox = "progress",
  range?: { from: string; to: string },
): Promise<ApprovalDocRow | null> {
  // ZUNIEWF_4500 caps 조회 at 3 months. Default to a rolling 3-month window
  // ending today (the recall path always operates on recent docs anyway).
  const r = range ?? last3MonthsRange();
  const rows = await listApprovalDocs(ctx, box, r);
  return rows.find((row) => row.GRONO === grono) ?? null;
}

function last3MonthsRange(): { from: string; to: string } {
  // ZUNIEWF_4500 enforces 최대 3개월 strictly. Stay well inside (~60 days) to
  // avoid edge-case rejection. In-flight 결재문서 are always recent anyway.
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const to = new Date();
  const from = new Date(to.getTime() - 60 * 24 * 3600 * 1000);
  return { from: fmt(from), to: fmt(to) };
}

/** Recall an in-progress approval document.
 *  Implementation: ApprovalStep with targetNamedServiceId=ZUNIEWF_4320 and APPR_STAT=E. */
export async function recallApprovalDoc(
  ctx: ClientContext,
  row: ApprovalDocRow,
  comment = "",
): Promise<string> {
  const fields: Record<string, string> = {};
  for (const k of Object.keys(row)) {
    const v = (row as any)[k];
    if (v == null) continue;
    fields[k] = String(v);
  }
  fields.SELECTED = "0";
  fields.APPR_STAT = "E";
  fields.APPR_TEXT = "";
  fields.APPR_TXT = "";
  fields.comments = comment;
  fields.showAsPopup = "true";
  fields.targetNamedServiceId = "ZUNIEWF_4320";
  fields.tableParamsString = "{}";
  const r = await callNS(ctx, "ApprovalStep", PROG_VIEWER, fields);
  return r?.NSReturn?.stringReturns?.message ?? "";
}

/* ── 결재선 (ZUNIEWF_2200/2201/2203/4101/1035) ─────────────────── */

/** 개인결재선설정 메뉴 */
export const PROG_APPROVAL_LINE = "UD_7010_011";

export interface PersonalLine {
  SEQ: string;
  SEQ_TXT: string;
  WF_LIN1: string;
  WF_LIN2: string;
  WF_LIN3: string;
  WF_LIN4: string;
  WF_LIN5: string;
  WF_USE: string;
  [k: string]: string;
}

/** Approver row in IT_DATA1 (matches what ZUNIEWF_2201 read/write uses). */
export interface ApprovalLineMember {
  SELECTED: string;
  WF_LINE_LEV: string;     // "1", "2", ...
  WF_SEQ: string;          // matches WF_LINE_LEV in practice
  DISPLAY_TEXT: string;    // "Member Leah Song (송현아)"
  WF_AGRET: string;
  WF_AGREE: string;
  WF_FINAN: string;
  BUKRS: string;
  WF_TYPE: string;
  WF_USER: string;
  JOB_KEY: string;         // "0000010001"
  JOB_KEY_TXT: string;     // "Member"
  NODE_KEY: string;        // department code
  NODE_KEY_TXT: string;    // department name
  POS_KEY: string;
  POS_KEY_TXT: string;
  WF_ID: string;           // "ZB01010" (EAC user id)
  WF_ID_TXT: string;       // "Leah Song (송현아)"
  WF_USER_TXT: string;
  [k: string]: string;
}

export async function listPersonalLines(
  ctx: ClientContext,
  programId: string = PROG_EA_MENU,
): Promise<PersonalLine[]> {
  const r = await callNS(ctx, "ZUNIEWF_2200", programId, { tableParamsString: "{}" });
  return (r?.NSReturn?.tableReturns?.OT_DATA as PersonalLine[] | undefined) ?? [];
}

/** ZUNIEWF_2203 — read approvers of a personal line (no GRONO needed). */
export async function readApprovalLineApprovers(
  ctx: ClientContext,
  line: PersonalLine,
): Promise<ApprovalLineMember[]> {
  const fields: Record<string, string> = {
    SELECTED: "1",
    SEQ: line.SEQ,
    SEQ_TXT: line.SEQ_TXT,
    WF_INIT: line.WF_INIT ?? "",
    LIN1_FLAG: line.LIN1_FLAG ?? "X",
    LIN2_FLAG: line.LIN2_FLAG ?? "",
    LIN3_FLAG: line.LIN3_FLAG ?? "",
    LIN4_FLAG: line.LIN4_FLAG ?? "",
    WF_APP_FORM: line.WF_APP_FORM ?? "",
    ID: line.ID ?? ctx.userId,
    WF_LIN1: line.WF_LIN1 ?? "",
    WF_LIN2: line.WF_LIN2 ?? "",
    WF_LIN3: line.WF_LIN3 ?? "",
    WF_LIN4: line.WF_LIN4 ?? "",
    WF_LIN5: line.WF_LIN5 ?? "",
    empty: "",
    tableParamsString: "{}",
  };
  const r = await callNS(ctx, "ZUNIEWF_2203", PROG_APPROVAL_LINE, fields);
  // Response shape varies. Try IT_DATA1 / OT_DATA1.
  const t = r?.NSReturn?.tableReturns ?? {};
  return (t.IT_DATA1 ?? t.OT_DATA1 ?? t.OT_DATA ?? []) as ApprovalLineMember[];
}

/** ZUNIEWF_2201 — save the approver list for a personal line. */
export async function saveApprovalLineApprovers(
  ctx: ClientContext,
  line: PersonalLine,
  approvers: ApprovalLineMember[],
): Promise<void> {
  // Renumber WF_LINE_LEV and WF_SEQ from 1.
  const IT_DATA1 = approvers.map((a, i) => ({
    SELECTED: "0",
    WF_LINE_LEV: String(i + 1),
    WF_SEQ: String(i + 1),
    DISPLAY_TEXT: a.DISPLAY_TEXT,
    WF_AGRET: a.WF_AGRET ?? "",
    WF_AGREE: a.WF_AGREE ?? "",
    WF_FINAN: a.WF_FINAN ?? "",
    BUKRS: a.BUKRS ?? "",
    WF_TYPE: a.WF_TYPE ?? "",
    WF_USER: a.WF_USER ?? "",
    JOB_KEY: a.JOB_KEY,
    JOB_KEY_TXT: a.JOB_KEY_TXT,
    NODE_KEY: a.NODE_KEY,
    NODE_KEY_TXT: a.NODE_KEY_TXT,
    POS_KEY: a.POS_KEY,
    POS_KEY_TXT: a.POS_KEY_TXT,
    WF_ID: a.WF_ID,
    WF_ID_TXT: a.WF_ID_TXT,
    WF_USER_TXT: a.WF_USER_TXT ?? "",
  }));
  const fields: Record<string, string> = {
    SELECTED: "1",
    SEQ: line.SEQ,
    SEQ_TXT: line.SEQ_TXT,
    WF_INIT: line.WF_INIT ?? "",
    LIN1_FLAG: line.LIN1_FLAG ?? "X",
    LIN2_FLAG: line.LIN2_FLAG ?? "",
    LIN3_FLAG: line.LIN3_FLAG ?? "",
    LIN4_FLAG: line.LIN4_FLAG ?? "",
    WF_APP_FORM: line.WF_APP_FORM ?? "",
    ID: line.ID ?? ctx.userId,
    WF_LIN1: line.WF_LIN1 ?? "",
    WF_LIN2: line.WF_LIN2 ?? "",
    WF_LIN3: line.WF_LIN3 ?? "",
    WF_LIN4: line.WF_LIN4 ?? "",
    WF_LIN5: line.WF_LIN5 ?? "",
    empty: "",
    tableParamsString: JSON.stringify({
      IT_DATA1,
      IT_DATA2: [],
      IT_DATA3: [],
      IT_DATA4: [],
    }),
  };
  await callNS(ctx, "ZUNIEWF_2201", PROG_APPROVAL_LINE, fields);
}

/** ZUNIEWF_1035 — search EAC users by name (Korean or English fragment).
 *  Server returns OT_USER with ID/ENAME (NOT WF_ID/WF_ID_TXT). */
export interface UserSearchHit {
  /** EAC user id (= PERNR for employees). Maps to WF_ID in approval line members. */
  WF_ID: string;
  /** Display name "Leah Song (송현아)". Maps to WF_ID_TXT. */
  WF_ID_TXT: string;
  PERNR: string;
  JOB_KEY: string;
  JOB_KEY_TXT: string;
  NODE_KEY: string;
  NODE_KEY_TXT: string;
  POS_KEY: string;
  POS_KEY_TXT: string;
  [k: string]: string;
}

export async function searchUsers(
  ctx: ClientContext,
  sname: string,
  programId: string = PROG_DRAFT,
): Promise<UserSearchHit[]> {
  const r = await callNS(ctx, "ZUNIEWF_1035", programId, {
    SNAME: sname,
    tableParamsString: "{}",
  });
  const raw = (r?.NSReturn?.tableReturns?.OT_USER ?? r?.NSReturn?.tableReturns?.OT_DATA ?? []) as Array<Record<string, string>>;
  return raw.map((u) => ({
    WF_ID: u.ID ?? u.PERNR ?? "",
    WF_ID_TXT: u.ENAME ?? "",
    PERNR: u.PERNR ?? "",
    JOB_KEY: u.JOB_KEY ?? "",
    JOB_KEY_TXT: u.JOB_KEY_TXT ?? "",
    NODE_KEY: u.NODE_KEY ?? "",
    NODE_KEY_TXT: u.NODE_KEY_TXT ?? "",
    POS_KEY: u.POS_KEY ?? "",
    POS_KEY_TXT: u.POS_KEY_TXT ?? "",
  }));
}

export async function getApprovers(
  ctx: ClientContext,
  line: PersonalLine,
  grono: string,
): Promise<Array<Record<string, string>>> {
  const r = await callNS(ctx, "ZUNIEWF_4101", PROG_DRAFT, {
    ...line,
    GRONO: grono,
    tableParamsString: "{}",
  });
  return (r?.NSReturn?.tableReturns?.OT_DATA1 as any) ?? [];
}

/* ── 비용 상신 primitives ───────────────────────────────────────────── */

/** 기본값 계산 (ZFBDT 등). */
export async function computeDefaults(
  ctx: ClientContext,
  user: UserProfile,
  bldat: string,
  budat: string,
  amountWon: number,
  title: string,
): Promise<{ zfbdt: string }> {
  const r = await callNS(ctx, "ZUNIEFI_4003", PROG_LEGACY, {
    BUDAT: budat, BLDAT: bldat, BLART: "KE",
    LIFNR: user.pernr, LIFNR_TXT: user.pernrName,
    BUPLA: "K100", GSBER: "K200", MWSKZ: "T0",
    AKONT: "21020103", ZTERM: "V123",
    WRBTR: String(amountWon), WRBTR_SLASH: "", WMWST: "0",
    BVTYP: "0001", ZFBDT: "", ZFBDT_SLASH: "",
    ZLSCH: "R", EMPTY: "",
    SGTXT: title, BUKRS: user.bukrs,
    tableParamsString: "{}",
  });
  const zfbdtStr: string = (r?.NSReturn?.exportMaps as any)?.OS_DATA?.ZFBDT ?? "";
  return { zfbdt: zfbdtStr.replace(/-/g, "") || computeZfbdtFallback(bldat) };
}

function computeZfbdtFallback(bldat: string): string {
  // ZTERM=V123 = "After Doc.Date + 1 Month (23th)" → next month's 23rd
  const y = parseInt(bldat.slice(0, 4), 10);
  const m = parseInt(bldat.slice(4, 6), 10);
  const next = new Date(y, m, 23);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${next.getFullYear()}${pad(next.getMonth() + 1)}${pad(next.getDate())}`;
}

/** 비용항목 1행. 여러 행이면 한 전표에 IT_DATA 로 함께 저장된다. */
export interface VoucherLine {
  item: ReimbursementItem;
  amountWon: number;
  /** 행 적요. 생략하면 전표 제목(title)을 쓴다. */
  sgtxt?: string;
}

/** Steps 1-5: Create a temp document (ZUNIEFI_4003 → 5030 → upload → 4006 → 5000). */
export async function createTempDoc(
  ctx: ClientContext,
  params: {
    user: UserProfile;
    item: ReimbursementItem;
    title: string;
    budat: string;
    bldat: string;
    amountWon: number;
    attachFiles: string[];
    /** 여러 행 전표. 주면 item/amountWon 대신 이 행들로 IT_DATA 를 만들고 amountWon 은 합계로 덮어쓴다. */
    lines?: VoucherLine[];
  },
): Promise<{ eviSeqEa: string; belnr: string; zfbdt: string }> {
  const { user, item, title, budat, bldat, attachFiles } = params;
  const lines: VoucherLine[] = params.lines?.length
    ? params.lines
    : [{ item, amountWon: params.amountWon }];
  const amountWon = lines.reduce((s, l) => s + l.amountWon, 0);

  const { zfbdt } = await computeDefaults(ctx, user, bldat, budat, amountWon, title);
  const eviSeqEa = await createAttachSeq(ctx, PROG_LEGACY);
  await uploadAttachments(ctx, eviSeqEa, attachFiles);

  const commonFi = {
    BUDAT: budat, BLDAT: bldat, BLART: "KE",
    LIFNR: user.pernr, LIFNR_TXT: user.pernrName,
    BUPLA: "K100", GSBER: "K200", MWSKZ: "T0",
    AKONT: "21020103", ZTERM: "V123",
    WRBTR: String(amountWon), WRBTR_SLASH: "", WMWST: "0",
    BVTYP: "0001", ZFBDT: zfbdt, ZFBDT_SLASH: "",
    ZLSCH: "R", EMPTY: "",
    SGTXT: title, BUKRS: user.bukrs,
    difference_amount: "0",
    debitSum: String(amountWon),
    creditSum: String(amountWon),
    GL_ALIAS: "", EMPTY1: "", EMPTY2: "", FAVOR: "",
    searchCondition: "HKONT", searchWord: "",
    EVI_SEQ: eviSeqEa,
    tableParamsString: JSON.stringify({
      IT_DATA: lines.map((l) => ({
        SELECTED: "1", SHKZG: "S",
        HKONT: l.item.hkont, HKONT_: "", HKONT_TXT: l.item.hkontText,
        WRBTR: String(l.amountWon),
        KOSTL: user.kostl, KOSTL_: "", KOSTL_TXT: user.kostlText,
        PROJK: "", PROJK_: "", PROJK_TXT: "",
        MWSKZ: "T0", SGTXT: l.sgtxt ?? title,
        ADD_DATA: "", ADD_DATA__HIDDEN: "", ADD_DATA_JSON: "",
      })),
      IT_ATTACH: [],
    }),
  };
  await callNS(ctx, "ZUNIEFI_4006", PROG_LEGACY, commonFi);

  const r5000 = await callNS(ctx, "ZUNIEFI_5000", PROG_LEGACY, commonFi);
  const belnr: string = (r5000?.NSReturn?.exportMaps as any)?.OS_DOCNO?.BELNR ?? "";
  if (!belnr) throw new ApiError("ZUNIEFI_5000", 200, "BELNR not returned", JSON.stringify(r5000));

  return { eviSeqEa, belnr, zfbdt };
}

/** Step 6: GRONO 예약. */
export async function reserveGrono(
  ctx: ClientContext,
  params: {
    user: UserProfile;
    item: ReimbursementItem;
    title: string;
    budat: string;
    bldat: string;
    zfbdt: string;
    amountWon: number;
    belnr: string;
    eviSeqEa: string;
    /** Override defaults from row when item-derived guesses don't match (e.g.
     *  법인카드: MWSKZ=V3 not T0, CRD_SEQ from card transaction, HKONT/HKONT_TXT
     *  whatever the form actually saved). Pass `row` from listTempDocs to keep
     *  the row identity stable. */
    rowOverrides?: Partial<TempDocRow>;
  },
): Promise<string> {
  const { user, item, title, budat, bldat, zfbdt, amountWon, belnr, eviSeqEa, rowOverrides } = params;
  const submitRow = {
    SELECTED: "1", GRONO: "",
    BSTAT_TXT: "임시전표", STATS_TXT: "미상신",
    BLART: "KE", BLART_TXT: "e-Accounting Doc.",
    EVIKB: item.evikb, EVIKB_TXT: item.evikbText,
    BELNR: belnr, DOKNR: belnr,
    BUDAT: budat, BLDAT: bldat, ZFBDT: zfbdt,
    LIFNR: user.pernr, LIFNR_TXT: user.pernrName,
    WRBTR: String(amountWon), DMBTR: String(amountWon), WAERS: "KRW",
    SGTXT: title,
    PERNR: user.pernr, PERNR_TXT: user.wfIdText,
    "EVIKB_@": "", EVIKB_ADD: "",
    MWSKZ: "T0", STATS: "", GRONO_IMAGE: "",
    CHECK_FLG: "", AUTO_FLG: "",
    ZLSCH_TXT: "실시간이체", ZLSCH: "R",
    XBLNR: `${user.pernr}/${user.pernrName}`,
    STATUS: "", NAME1: "",
    KOSTL_TXT: user.kostlText, KOSTL: user.kostl,
    INV_SEQ: "",
    HKONT_TXT: item.hkontText, HKONT: item.hkont,
    GJAHR: budat.slice(0, 4),
    EVI_SEQ: eviSeqEa,
    CRD_SEQ: "", BUKRS: user.bukrs, BSTAT: "V",
    APPR_STAT_TXT: "", APPR_STATS_TXT: "", APPR_STATS: "", APPR_STAT: "",
    APPR_SEQ_STAT_TXT: "", APPR_SEQ_STAT_INT: "",
    APPR_SEQ_STATS_TXT: "", APPR_SEQ_STATS: "", APPR_SEQ_STAT: "",
    ...(rowOverrides ?? {}),
  };
  const r = await callNS(ctx, "ZUNIEFI_4203", PROG_EA_MENU, {
    tableParamsString: JSON.stringify({ IT_DATA: [submitRow] }),
  });
  const oUrl: string = r?.NSReturn?.stringReturns?.O_URL ?? "";
  const grono = oUrl.match(/GRONO=([^&]+)/)?.[1] ?? "";
  if (!grono) throw new ApiError("ZUNIEFI_4203", 200, "GRONO not parsed from O_URL", oUrl);
  return grono;
}

/** Step 6 (batch): GRONO 예약 with multiple BELNR rows. ZUNIEFI_4203's IT_DATA
 *  accepts an array — each row contributes a BELNR to the same GRONO. Used to
 *  group multi-line travel expense settlements into a single approval doc. */
export async function reserveGronoBatch(
  ctx: ClientContext,
  params: {
    user: UserProfile;
    item: ReimbursementItem;
    items: Array<{
      belnr: string;
      budat: string;
      bldat: string;
      zfbdt: string;
      amountWon: number;
      eviSeqEa: string;
      sgtxt: string;
      rowOverrides?: Partial<TempDocRow>;
    }>;
  },
): Promise<string> {
  const { user, item, items } = params;
  if (items.length === 0) throw new Error("reserveGronoBatch: empty items[]");
  const submitRows = items.map((it) => ({
    SELECTED: "1", GRONO: "",
    BSTAT_TXT: "임시전표", STATS_TXT: "미상신",
    BLART: "KE", BLART_TXT: "e-Accounting Doc.",
    EVIKB: item.evikb, EVIKB_TXT: item.evikbText,
    BELNR: it.belnr, DOKNR: it.belnr,
    BUDAT: it.budat, BLDAT: it.bldat, ZFBDT: it.zfbdt,
    LIFNR: user.pernr, LIFNR_TXT: user.pernrName,
    WRBTR: String(it.amountWon), DMBTR: String(it.amountWon), WAERS: "KRW",
    SGTXT: it.sgtxt,
    PERNR: user.pernr, PERNR_TXT: user.wfIdText,
    "EVIKB_@": "", EVIKB_ADD: "",
    MWSKZ: "T0", STATS: "", GRONO_IMAGE: "",
    CHECK_FLG: "", AUTO_FLG: "",
    ZLSCH_TXT: "실시간이체", ZLSCH: "R",
    XBLNR: `${user.pernr}/${user.pernrName}`,
    STATUS: "", NAME1: "",
    KOSTL_TXT: user.kostlText, KOSTL: user.kostl,
    INV_SEQ: "",
    HKONT_TXT: item.hkontText, HKONT: item.hkont,
    GJAHR: it.budat.slice(0, 4),
    EVI_SEQ: it.eviSeqEa,
    CRD_SEQ: "", BUKRS: user.bukrs, BSTAT: "V",
    APPR_STAT_TXT: "", APPR_STATS_TXT: "", APPR_STATS: "", APPR_STAT: "",
    APPR_SEQ_STAT_TXT: "", APPR_SEQ_STAT_INT: "",
    APPR_SEQ_STATS_TXT: "", APPR_SEQ_STATS: "", APPR_SEQ_STAT: "",
    ...(it.rowOverrides ?? {}),
  }));
  const r = await callNS(ctx, "ZUNIEFI_4203", PROG_EA_MENU, {
    tableParamsString: JSON.stringify({ IT_DATA: submitRows }),
  });
  const oUrl: string = r?.NSReturn?.stringReturns?.O_URL ?? "";
  const grono = oUrl.match(/GRONO=([^&]+)/)?.[1] ?? "";
  if (!grono) throw new ApiError("ZUNIEFI_4203", 200, "GRONO not parsed from O_URL", oUrl);
  return grono;
}

/** Default inline body used by the 결재요청 form (copied verbatim from UI payload). */
export const DEFAULT_I_BODY = `<strong>*원품의 또는 별도 정책에 근거한 비용집행내용을 아래 양식에 따라 작성하되, 필요시 추가내용 작성 가능</strong><br><p style="color:red;">(본 안내사항은 삭제 후 내용 작성)</p><br><br><strong>1. 지급조건</strong><br>   (ex) 계약체결 후 30일 이내 계약금 00원 지급, 1차 납품일로부터 30일 이내 중도금 00원 지급, 매월 00일/매분기 말일 지급<br><br><strong>2. 지급조건 달성여부</strong><br>   (ex) 계약체결일, 납품일, 수령일 등 기재<br><br><strong>3. 지급기한</strong><br>   - 계약서 또는 정책상 가장 늦은 지급기일 (만약 조기 집행하는 경우 그 사유를 명시)<br><br><strong>4. 기타</strong><br>   - 기타 지급품의에 기술되어야 하는 내용 기재`;

/** Steps 7-11: register a 결재문서용 EVI_SEQ, upload attachments, pick the line,
 *  fire ApprovalStep. `EVI_SEQ=<결재문서용>` in the final body is what triggers
 *  `WF_ATTACH_FLAG=X` on the approval list. */
export async function submitApproval(
  ctx: ClientContext,
  params: {
    user: UserProfile;
    item: ReimbursementItem;
    title: string;
    amountWon: number;
    grono: string;
    attachFiles: string[];
    iBody?: string;
    /** "품의 첨부 (원품의 외)" rows for the DRAFT_0010 popup. Travel-cost 결재
     *  is reject'd by 회계 unless the row carries the originating Flex 출장
     *  품의서 URL. WF_ITKD codes (from ZUNIECM_3001 FOBJ=WF_ITKD): A=원품의,
     *  B=날인품의, C=기타. URL must be a fully-qualified http(s) link — the
     *  popup-side validator rejects bare paths. */
    refDocs?: Array<{ URL: string; WF_ITKD: "A" | "B" | "C" }>;
  },
): Promise<{ eviSeqDraft: string; message: string }> {
  const { user, item, title, amountWon, grono, attachFiles, iBody, refDocs } = params;

  const eviSeqDraft = await createAttachSeq(ctx, PROG_DRAFT);
  await uploadAttachments(ctx, eviSeqDraft, attachFiles);
  const sess = await listAttachments(ctx, eviSeqDraft);
  if (sess.length !== attachFiles.length) {
    throw new Error(`draft attachment mismatch: expected ${attachFiles.length}, saw ${sess.length}`);
  }

  const lines = await listPersonalLines(ctx);
  const wfLine = lines.find((l) => l.SEQ === item.wfLineSeq && l.WF_LIN1 === item.wfLineLin1)
    ?? lines.find((l) => l.SEQ === item.wfLineSeq)
    ?? lines.find((l) => (l.SEQ_TXT ?? "").includes(item.evikbText));
  if (!wfLine) {
    throw new Error(`개인결재선 not found: SEQ=${item.wfLineSeq}. Register "[개인]-${item.evikbText}" in 결재선 관리.`);
  }

  const approvers = await getApprovers(ctx, wfLine, grono);
  if (!approvers.length) throw new ApiError("ZUNIEWF_4101", 200, "empty approver list", "");

  const IT_DATA1: ApprovalLine[] = approvers.map((a) => ({
    ...a,
    SELECTED: "0",
    DISPLAY_TEXT: `${a.JOB_KEY_TXT ?? ""} ${a.WF_ID_TXT ?? ""}`.trim(),
    WF_LINE_LEV: parseInt(String(a.WF_LINE_LEV ?? "0"), 10),
    WF_SEQ: String(parseInt(String(a.WF_SEQ ?? "0"), 10)),
    WF_AGREE: "",
  }));

  // "품의 첨부 (원품의 외)" rows. The popup form's request handler renames
  // WF_ITKD → ITKD before posting; mirror that here.
  const IT_ITKD = (refDocs ?? []).map((d) => {
    if (!/^https?:\/\//i.test(d.URL)) {
      throw new Error(`refDoc URL must start with http:// or https:// — got: ${d.URL}`);
    }
    if (!["A", "B", "C"].includes(d.WF_ITKD)) {
      throw new Error(`refDoc WF_ITKD must be A(원품의)/B(날인품의)/C(기타) — got: ${d.WF_ITKD}`);
    }
    return { SELECTED: "0", URL: d.URL, ITKD: d.WF_ITKD };
  });

  const r = await callNS(ctx, "ApprovalStep", PROG_DRAFT, {
    BUKRS: user.bukrs, WF_GB: "10", showAsPopup: "true",
    PERNR: user.pernr, WF_TYPE: "C", WF_AMOUNT: String(amountWon),
    ID: user.pernr, GRONO: grono, WF_TITLE: title,
    I_BODY: iBody ?? DEFAULT_I_BODY,
    EVI_SEQ: eviSeqDraft,
    WF_SECUR: "",
    targetNamedServiceId: "ZUNIEWF_4201",
    tableParamsString: JSON.stringify({ IT_DATA1, IT_ITKD }),
  });
  const message: string = r?.NSReturn?.stringReturns?.message ?? "";
  if (!/상신/.test(message)) throw new ApiError("ApprovalStep", 200, `unexpected message: ${message}`, JSON.stringify(r));

  return { eviSeqDraft, message };
}


/* ── 법인카드(공용) — UD_0201_00x ──────────────────────────────────── */

export interface CardTransaction {
  CRD_SEQ: string;
  CCOMP: string;            // C07 = 현대카드
  CCOMP_TXT: string;        // 현대카드
  CTYPE: string;            // B
  CARDNO: string;           // 5531-4210-3280-0000
  APPR_NO: string;          // 00628786
  APPR_DATE: string;        // YYYYMMDD
  APPR_TIME: string;        // HH:MM:SS
  APPR_DATE_APPR_TIME: string; // YYYY-MM-DD HH:MM:SS
  MERCH_NAME: string;
  MERCH_BIZ_NO: string;
  MERCH_NO: string;
  MERCH_TEL: string;
  MERCH_ADDR1: string;
  MERCH_ADDR2: string;
  MERCH_ZIP_CODE: string;
  TOTAL: string;            // 결제금액 (with VAT)
  AMOUNT: string;           // 공급가액
  TAX: string;              // 부가세
  TIPS: string;
  FTOTAL: string;
  MCC_CODE: string;
  MCC_TAXKB: string;
  MCC_TAXKB_TXT: string;    // 일반과세 / 면세
  MCC_NAME: string;         // 일반한식 / 슈퍼마켓 / ...
  PERNR: string;
  PERNR_TXT: string;
  LIFNR: string;
  LIFNR_TXT: string;
  BPERNR: string;
  BPERNR_TXT: string;
  BERDAT: string;
  BERZET: string;
  PURC_NO: string;
  SETT_DATE: string;
  MASTER: string;
  BUKRS: string;
  WAERS: string;
  DELFLG: string;
  DELCODE: string;
  DELCODE_TXT: string;
  DPERNR: string;
  DPERNR_TXT: string;
  DERDAT: string;
  DERZET: string;
  WRBTR: string;
  HKONT: string;
  APPR_TYPE: string;
  [k: string]: string;
}

export interface CardListFilter {
  from: string;       // YYYYMMDD
  to: string;         // YYYYMMDD
  pernrName?: string; // optional, defaults to user's name (server doesn't strictly need it)
  merchName?: string; // optional substring filter
}

/** ZUNIEFI_1000 — 법인카드 사용내역 조회 (UD_0201_000). 처리 가능한 미정산 거래만 반환. */
export async function listCardTransactions(
  ctx: ClientContext,
  user: UserProfile,
  filter: CardListFilter,
): Promise<CardTransaction[]> {
  const r = await callNS(ctx, "ZUNIEFI_1000", PROG_CORPCARD_LIST, {
    DATE_FR: filter.from, DATE_TO: filter.to,
    CARDNO: "", CARDNO_TXT: "",
    PERNR: user.pernr, PERNR_TXT: filter.pernrName ?? user.pernrName,
    MODE: "A", MODE2: "A", AP_NUM: "",
    BUKRS: user.bukrs,
    MERCH_NAME: filter.merchName ?? "",
    MCC_NAME: "", EMPTY: "",
    tableParamsString: "{}",
  });
  return (r?.NSReturn?.tableReturns?.OT_DATA as CardTransaction[] | undefined) ?? [];
}

export interface CorpCardCreateParams {
  user: UserProfile;
  card: CardTransaction;
  hkont: string;
  hkontText: string;
  sgtxt: string;          // 적요 — `[법인카드/거래처/참석자]` 등
  budat: string;          // YYYYMMDD — 전기일 (default: today; for prior-month closing must be 익월 1일)
  bldat?: string;         // YYYYMMDD — 증빙일 (default: 카드 승인일)
  zfbdt?: string;         // YYYYMMDD — 지급기일 (default: server computes via ZTERM=V123)
}

/** Common ZFBDT default: ZTERM=V123 = After Doc.Date + 1 Month (23rd). */
function nextMonth23rd(yyyymmdd: string): string {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10);
  const d = new Date(y, m, 23);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** Resolve MWSKZ for a card transaction. EAC's UD_0201_001 form defaults this
 *  based on whether VAT is separated on the receipt:
 *    TAX > 0  → V3 (10% 매입_과세_신용카드) — typical retail with 부가세 분리
 *    TAX == 0 → T0 (0% 매입_세액 무관)    — 영세율/면세 (e.g. BSP항공권, 해외출장)
 *  접대비(3H)/면세사업(3D) 등 특수 케이스가 필요하면 호출부에서 mwskz를 직접 전달. */
function resolveMwskz(tax: string): "V3" | "T0" {
  return parseFloat(tax || "0") > 0 ? "V3" : "T0";
}

/** ZUNIEFI_4006 (검증) + ZUNIEFI_1009 (SAP posting → BELNR). 카드는 첨부 EVI_SEQ 없음
 *  (영수증은 카드사가 SAP 후단에 자동 첨부). */
export async function createCorpCardVoucher(
  ctx: ClientContext,
  p: CorpCardCreateParams & { mwskz?: string },
): Promise<{ belnr: string }> {
  const { user, card } = p;
  const bldat = p.bldat ?? card.APPR_DATE;
  const zfbdt = p.zfbdt ?? nextMonth23rd(bldat);
  const mwskz = p.mwskz ?? resolveMwskz(card.TAX);

  const formFields: Record<string, string> = {
    SELECTED: "1",
    // Card row passthrough (mirrors UI form transition)
    CCOMP_TXT: card.CCOMP_TXT,
    CTYPE: card.CTYPE, CARDNO: card.CARDNO,
    APPR_NO: card.APPR_NO, APPR_DATE: card.APPR_DATE, APPR_TIME: card.APPR_TIME,
    MERCH_NAME: card.MERCH_NAME,
    TOTAL: card.TOTAL, AMOUNT: card.AMOUNT, TAX: card.TAX, TIPS: card.TIPS, FTOTAL: card.FTOTAL,
    MCC_TAXKB_TXT: card.MCC_TAXKB_TXT, MCC_NAME: card.MCC_NAME,
    PERNR_TXT: card.PERNR_TXT, BPERNR_TXT: card.BPERNR_TXT ?? "",
    MERCH_ADDR1: card.MERCH_ADDR1, MERCH_ADDR2: card.MERCH_ADDR2,
    CRD_SEQ: card.CRD_SEQ,
    BUKRS: user.bukrs,
    CCOMP: card.CCOMP, APPR_TYPE: card.APPR_TYPE,
    PERNR: card.PERNR, LIFNR: card.LIFNR, LIFNR_TXT: card.LIFNR_TXT,
    MCC_CODE: card.MCC_CODE, MCC_TAXKB: card.MCC_TAXKB,
    BPERNR: card.BPERNR ?? "",
    BERDAT: card.BERDAT || "0000-00-00",
    BERZET: card.BERZET || "00:00:00",
    PURC_NO: card.PURC_NO, SETT_DATE: card.SETT_DATE,
    MASTER: card.MASTER,
    MERCH_BIZ_NO: card.MERCH_BIZ_NO, MERCH_NO: card.MERCH_NO,
    MERCH_TEL: card.MERCH_TEL, MERCH_ZIP_CODE: card.MERCH_ZIP_CODE,
    WAERS: card.WAERS,
    DELFLG: "", DELCODE: "", DELCODE_TXT: "",
    DPERNR: "", DPERNR_TXT: "",
    DERDAT: "0000-00-00", DERZET: "00:00:00",
    HKONT: "",
    WRBTR: card.TOTAL,
    APPR_DATE_APPR_TIME: card.APPR_DATE_APPR_TIME,
    BUTTON_ID: "UD_0201_001",
    // Form-side derived (constants observed across all corpcard captures)
    J_1KFTBUS: "", STCD2: "", LOEVM: "", PAY_TXT50: "",
    EMAIL: `${user.pernr}@ZIGBANG.COM`,
    EMPFB: "", EMPFB_TXT: "", STCD1: "", ZAHLS: "",
    AKONT: "21020103", ZTERM: "V123", BVTYP: "0001", ZLSCH: "R",
    TXT50: "미지급금-종업원",
    J_1KFTIND: "",
    TEXT1: "After Doc.Date + 1 Month (23th)",
    ADRNR: "0000010746",
    KTOKK: "Z230", ZWELS: "",
    ZFBDT: zfbdt, GL_ALIAS: "", XCPDK: "", J_1KFREPRE: "",
    MWSKZ: mwskz, AKONT_PAY: "",
    WRBTR_READ_ONLY: card.TOTAL,
    CHARGETOTAL: card.AMOUNT, CHARGETOTAL_Slash: "",
    WMWST_READ_ONLY: card.TAX,
    BUDAT: p.budat, BLDAT: bldat, BLART: "KE",
    BUPLA: "K100", GSBER: "K200",
    WRBTR_SLASH: "", WMWST: card.TAX,
    ZFBDT_SLASH: "", EMPTY: "",
    SGTXT: p.sgtxt,
    difference_amount: "0",
    debitSum: card.TOTAL, creditSum: card.TOTAL,
    EMPTY1: "", EMPTY2: "",
  };

  const itDataRow = {
    SELECTED: "0", SHKZG: "S",
    HKONT: p.hkont, HKONT_: "", HKONT_TXT: p.hkontText,
    WRBTR: card.AMOUNT,
    ADD_DATA: "", ADD_DATA__HIDDEN: "", ADD_DATA_JSON: "",
    KOSTL: user.kostl, KOSTL_: "", KOSTL_TXT: user.kostlText,
    PROJK: "", PROJK_: "", PROJK_TXT: "",
    AUFNR: "", AUFNR_: "", AUFNR_TXT: "",
    MWSKZ: mwskz,
    SGTXT: p.sgtxt,
  };
  const tableParamsString = JSON.stringify({ IT_DATA: [itDataRow], IT_ATTACH: [] });

  // 4006 — validate. UI calls it before 1009; mirrors that flow.
  await callNS(ctx, "ZUNIEFI_4006", PROG_CORPCARD_FORM, { ...formFields, tableParamsString });

  // 1009 — SAP posting; returns BELNR.
  const r = await callNS(ctx, "ZUNIEFI_1009", PROG_CORPCARD_FORM, { ...formFields, tableParamsString });
  const exp = (r?.NSReturn?.exportMaps as any) ?? {};
  const sret = r?.NSReturn?.stringReturns ?? {};
  const belnr: string =
    exp?.OS_DOCNO?.BELNR
    ?? exp?.OS_DATA?.BELNR
    ?? sret?.O_BELNR
    ?? sret?.BELNR
    ?? "";
  if (!belnr) throw new ApiError("ZUNIEFI_1009", 200, "BELNR not returned", JSON.stringify(r).slice(0, 500));
  return { belnr };
}

/* ── helpers ───────────────────────────────────────────────────────── */

/** Wide default date range (current year). */
export function defaultYearRange(): { from: string; to: string } {
  const y = new Date().getFullYear();
  return { from: `${y}0101`, to: `${y}1231` };
}

/** Today in YYYYMMDD. */
export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
