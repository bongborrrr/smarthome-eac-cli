/**
 * 전표 (FI) commands — wraps ZUNIEFI_* services.
 *
 *   voucher list                         ZUNIEFI_4200
 *   voucher show <BELNR|GRONO>           ZUNIEFI_4207
 *   voucher create                       Steps 1-5 (전표 작성 → BELNR)
 *   voucher request-approval <BELNR>     Steps 6-11 (결재요청 → GRONO + 상신)
 *   voucher cancel-group <GRONO>         ZUNIEFI_4202 (그룹번호취소)
 *   voucher attach new|upload|list       전표 레이어 EVI_SEQ
 *
 * Note: 전표 작성 + 결재요청을 한 번에 하는 composite는 일부러 빼두었다.
 * 실패 시 (e.g. BELNR 발급 후 결재요청 단계 실패) 중간 상태가 숨겨져
 * 복구 동작을 헷갈리게 만든다. 한 방 실행이 필요하면 shell script에서
 * create → request-approval 두 단계를 명시적으로 조합 (README 참조).
 */

import { defineCommand } from "citty";
import { readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadCtx, resolveItem, requireUser, currentMonthRange, formatWon } from "../lib/cli.ts";
import {
  PROG_LEGACY,
  listTempDocs,
  cancelTempDocGroup,
  deleteTempDoc,
  showApprovalDoc,
  parseFileGroupIdFromUrl,
  createTempDoc,
  reserveGrono,
  reserveGronoBatch,
  submitApproval,
  createAttachSeq,
  uploadAttachments,
  listAttachments,
  today,
} from "../lib/ops.ts";

/** Last-3-months window (server caps ZUNIEFI_4200 조회 기간 to 3 months). */
function last3MonthsRange(): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const to = new Date();
  const from = new Date(to);
  from.setMonth(from.getMonth() - 3);
  return { from: fmt(from), to: fmt(to) };
}

function collectAttachments(dir: string): string[] {
  const absDir = resolve(dir);
  const files = readdirSync(absDir)
    .filter((n) => !n.startsWith(".") && statSync(join(absDir, n)).isFile())
    .map((n) => join(absDir, n));
  if (files.length === 0) throw new Error(`no attachment files in ${absDir}`);
  return files;
}

export { collectAttachments };

/**
 * `--line "<preset>:<amount>[:<적요>]"` 를 반복 수집한다. citty 는 같은 플래그가
 * 여러 번 오면 마지막 값만 남길 수 있어 rawArgs 에서 직접 읽는다.
 * 적요에는 ':' 가 들어갈 수 있으므로 앞의 두 개만 구분자로 쓴다.
 */
function parseLineArgs(rawArgs: string[]): Array<{ preset: string; amountWon: number; sgtxt?: string }> {
  const values: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]!;
    if (a === "--line" && i + 1 < rawArgs.length) values.push(rawArgs[++i]!);
    else if (a.startsWith("--line=")) values.push(a.slice("--line=".length));
  }
  return values.map((v) => {
    const [preset, amount, ...rest] = v.split(":");
    const amountWon = parseInt(amount ?? "", 10);
    if (!preset || !Number.isFinite(amountWon) || amountWon <= 0) {
      throw new Error(`invalid --line "${v}" (expected "<preset>:<amount>[:<적요>]")`);
    }
    const sgtxt = rest.join(":").trim();
    return { preset, amountWon, sgtxt: sgtxt || undefined };
  });
}

/* ── list ───────────────────────────────────────────────────────── */

const listSub = defineCommand({
  meta: { name: "list", description: "List 전표 (ZUNIEFI_4200). Defaults to BSTAT=V (임시전표)." },
  args: {
    from: { type: "string", description: "BUDAT_FR YYYYMMDD (default: first of current month)" },
    to: { type: "string", description: "BUDAT_TO YYYYMMDD (default: today)" },
    bstat: { type: "string", default: "V", description: 'BSTAT: V (임시전표) | *' },
    stats: { type: "string", default: "*", description: 'STATS: "" (미상신) | C (회수) | R (반려) | 2 (진행중) | 4 (승인) | *' },
    evikb: { type: "string", description: "Filter by EVIKB (FI_21 / FI_22 / ...)" },
    belnr: { type: "string", description: "Filter by BELNR" },
  },
  async run({ args }) {
    const { ctx, cfg } = await loadCtx();
    const def = currentMonthRange();
    const rows = await listTempDocs(ctx, {
      from: args.from ?? def.from,
      to: args.to ?? def.to,
      bstat: args.bstat,
      stats: args.stats,
      evikb: args.evikb,
      belnr: args.belnr,
    }, cfg.user);
    console.log(`${rows.length} rows`);
    for (const r of rows) {
      const grono = r.GRONO || "(no GRONO)    ";
      console.log(
        `  ${grono.padEnd(18)}  BELNR=${r.BELNR}  ${r.BUDAT}  ${(r.EVIKB_TXT ?? "").padEnd(10)}` +
        `  ${formatWon(parseInt(r.WRBTR ?? "0", 10)).padStart(10)}` +
        `  ${(r.BSTAT_TXT ?? "").padEnd(6)}/${(r.STATS_TXT ?? "").padEnd(6)}  ${r.SGTXT ?? r.BKTXT ?? ""}`,
      );
    }
  },
});

/* ── show ───────────────────────────────────────────────────────── */

const showSub = defineCommand({
  meta: { name: "show", description: "Show 전표 detail (ZUNIEFI_4207)." },
  args: {
    key: { type: "positional", required: true, description: "GRONO (FI20260000...) or BELNR" },
  },
  async run({ args }) {
    const { ctx, cfg } = await loadCtx();
    let grono = args.key;
    if (!args.key.startsWith("FI")) {
      // Resolve BELNR → GRONO via temp list. ZUNIEFI_4200 caps 조회 at 3 months.
      const rows = await listTempDocs(ctx, { ...last3MonthsRange(), belnr: args.key }, cfg.user);
      if (!rows.length) { console.error(`BELNR ${args.key} not found`); process.exit(1); }
      if (!rows[0].GRONO) {
        console.error(`BELNR ${args.key} has no GRONO yet (전표 작성만 된 상태)`);
        console.log(`BELNR      ${rows[0].BELNR}`);
        console.log(`EVI_SEQ    ${rows[0].EVI_SEQ}`);
        return;
      }
      grono = rows[0].GRONO;
    }
    const doc = await showApprovalDoc(ctx, grono);
    if (!doc) { console.error(`GRONO ${grono} not found`); process.exit(1); }
    const amountText = (doc.DMBTR_TXT ?? doc.WRBTR_TXT ?? "").trim();
    console.log(`GRONO            ${doc.GRONO}`);
    console.log(`BELNR            ${doc.BELNR}`);
    console.log(`TITLE            ${doc.BKTXT ?? doc.SGTXT}`);
    console.log(`BUDAT / BLDAT    ${doc.BUDAT} / ${doc.BLDAT}`);
    console.log(`AMOUNT           ₩${amountText} (${doc.WAERS})`);
    console.log(`HKONT            ${doc.HKONT} (${doc.HKONT_TXT})`);
    console.log(`KOSTL            ${doc.KOSTL} (${doc.KOSTL_TXT})`);
    const fgid = parseFileGroupIdFromUrl(doc.URL ?? "");
    console.log(`attach EVI_SEQ   ${fgid ?? "(none)"}`);
    if (doc.URL) console.log(`attach URL       ${doc.URL}`);
  },
});

/* ── create (Steps 1-5: 전표 작성) ──────────────────────────────── */

const createSub = defineCommand({
  meta: { name: "create", description: "전표 작성 (Steps 1-5 → BELNR). No approval yet." },
  args: {
    item: { type: "string", description: "Preset name from config.items (required unless --line is given)" },
    title: { type: "string", required: true, description: "Document title" },
    budat: { type: "string", description: "Posting date YYYYMMDD (default: today)" },
    bldat: { type: "string", required: true, description: "Receipt date YYYYMMDD" },
    amount: { type: "string", description: "Amount in won (integer). Required unless --line is given" },
    line: { type: "string", description: "비용항목 1행: \"<preset>:<amount>[:<적요>]\". Repeat for multiple rows in one 전표 (replaces --item/--amount)" },
    "attach-dir": { type: "string", description: "Directory of attachment files (optional at create)" },
  },
  async run({ args, rawArgs }) {
    const { ctx, cfg } = await loadCtx();
    const lines = parseLineArgs(rawArgs).map((l) => ({ ...l, item: resolveItem(cfg, l.preset) }));
    if (lines.length > 0) {
      const evikbs = new Set(lines.map((l) => l.item.evikb));
      if (evikbs.size > 1) throw new Error(`--line presets must share one evikb (got ${[...evikbs].join(", ")})`);
    } else if (!args.item || !args.amount) {
      throw new Error("either --line (repeatable) or both --item and --amount are required");
    }
    const res = await createTempDoc(ctx, {
      user: requireUser(cfg),
      item: lines[0]?.item ?? resolveItem(cfg, args.item!),
      title: args.title,
      budat: args.budat ?? today(),
      bldat: args.bldat,
      amountWon: lines.length ? 0 : parseInt(args.amount!, 10),
      lines: lines.map(({ item, amountWon, sgtxt }) => ({ item, amountWon, sgtxt })),
      attachFiles: args["attach-dir"] ? collectAttachments(args["attach-dir"]) : [],
    });
    console.log(`BELNR            ${res.belnr}`);
    console.log(`EVI_SEQ (FI)     ${res.eviSeqEa}`);
    console.log(`ZFBDT            ${res.zfbdt}`);
  },
});

/* ── request-approval (Steps 6-11: 결재요청) ────────────────────── */

const requestApprovalSub = defineCommand({
  meta: { name: "request-approval", description: "결재요청 on a 전표 (Steps 6-11 → GRONO + 상신)." },
  args: {
    belnr: { type: "positional", required: true, description: "BELNR of an existing 전표 (STATS=미상신)" },
    item: { type: "string", required: true, description: "Preset name from config.items" },
    title: { type: "string", required: true, description: "Document title (used for 결재문서 제목)" },
    "attach-dir": { type: "string", description: "Directory of attachment files. Optional for 법인카드 (영수증 자동); required for 자기관리비/일반경비 to flip 결재함의 📎 표시." },
    "i-body": { type: "string", description: "Optional inline body override" },
    "ref-url": { type: "string", description: "원품의/날인품의 URL (출장비 결재에 회계팀이 요구). Format: http(s):// + 풀 URL. Repeatable via comma. Pair with --ref-kind." },
    "ref-kind": { type: "string", description: "원품의 종류 코드. A=원품의 (default, Flex 출장 품의서 등), B=날인품의, C=기타. URL이 여러 개면 콤마로 같은 순서대로." },
  },
  async run({ args }) {
    const { ctx, cfg } = await loadCtx();
    const user = requireUser(cfg);
    const item = resolveItem(cfg, args.item);

    // Resolve BELNR → row. ZUNIEFI_4200 caps at 3 months.
    const rows = await listTempDocs(ctx, {
      ...last3MonthsRange(),
      bstat: "V", stats: "*", belnr: args.belnr,
    }, user);
    const row = rows[0];
    if (!row) { console.error(`BELNR ${args.belnr} not found`); process.exit(1); }
    if (row.GRONO) {
      console.error(`BELNR ${args.belnr} already has GRONO=${row.GRONO}. Recall + cancel-group first.`);
      process.exit(1);
    }
    const amountWon = parseInt(row.WRBTR.split(".")[0], 10);
    const grono = await reserveGrono(ctx, {
      user, item,
      title: args.title,
      budat: row.BUDAT.replace(/-/g, ""),
      bldat: row.BLDAT.replace(/-/g, ""),
      zfbdt: row.ZFBDT.replace(/-/g, ""),
      amountWon,
      belnr: row.BELNR,
      eviSeqEa: row.EVI_SEQ,
      // Mirror the actual saved row (MWSKZ, HKONT, CRD_SEQ — these diverge from
      // item defaults for 법인카드: V3 not T0, real card-charged HKONT, CRD_SEQ).
      rowOverrides: {
        MWSKZ: row.MWSKZ,
        HKONT: row.HKONT,
        HKONT_TXT: row.HKONT_TXT,
        CRD_SEQ: (row as any).CRD_SEQ ?? "",
        EVIKB: row.EVIKB,
        EVIKB_TXT: row.EVIKB_TXT,
      },
    });
    const attachFiles = args["attach-dir"] ? collectAttachments(args["attach-dir"]) : [];
    const refUrls = (args["ref-url"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const refKindsRaw = (args["ref-kind"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const refKinds = refUrls.map((_, i) => refKindsRaw[i] ?? refKindsRaw[0] ?? "A");
    const refDocs = refUrls.map((url, i) => {
      const k = refKinds[i];
      if (!["A", "B", "C"].includes(k)) {
        console.error(`--ref-kind must be A/B/C — got '${k}'`); process.exit(1);
      }
      return { URL: url, WF_ITKD: k as "A" | "B" | "C" };
    });
    const res = await submitApproval(ctx, {
      user, item, title: args.title, amountWon,
      grono, attachFiles, iBody: args["i-body"],
      refDocs: refDocs.length ? refDocs : undefined,
    });
    console.log(res.message);
    console.log(`GRONO            ${grono}`);
    console.log(`EVI_SEQ (draft)  ${res.eviSeqDraft}`);
    if (attachFiles.length === 0) {
      console.log(`(no attach-dir → 결재함 📎 표시 없음. 법인카드는 정상; 자기관리비/일반경비는 영수증 누락이니 회수해서 다시 올릴 것)`);
    }
  },
});

/* ── request-approval-batch (Multiple BELNR → 1 GRONO) ─────────── */

const requestApprovalBatchSub = defineCommand({
  meta: { name: "request-approval-batch", description: "Batch 결재요청: 여러 BELNR을 하나의 GRONO로 묶어 상신. 출장비 다건 정산에 사용." },
  args: {
    belnrs: { type: "positional", required: true, description: "BELNR list, comma-separated (e.g. 3200005920,3200005921,...)" },
    item: { type: "string", required: true, description: "Preset name from config.items" },
    title: { type: "string", required: true, description: "Document title (used for 결재문서 제목)" },
    "i-body": { type: "string", description: "Optional inline body override" },
    "ref-url": { type: "string", description: "원품의/날인품의 URL. Format: http(s):// + 풀 URL. Repeatable via comma. Pair with --ref-kind." },
    "ref-kind": { type: "string", description: "원품의 종류 코드. A=원품의 (default), B=날인품의, C=기타. URL이 여러 개면 콤마로 같은 순서대로." },
  },
  async run({ args }) {
    const { ctx, cfg } = await loadCtx();
    const user = requireUser(cfg);
    const item = resolveItem(cfg, args.item);

    const belnrList = args.belnrs.split(",").map((s) => s.trim()).filter(Boolean);
    if (belnrList.length === 0) { console.error("No BELNR provided"); process.exit(1); }

    // Resolve every BELNR row up front so we fail fast on missing/already-grouped entries.
    const tempDocs = await listTempDocs(ctx, {
      ...last3MonthsRange(),
      bstat: "V", stats: "*",
    }, user);
    const items: Parameters<typeof reserveGronoBatch>[1]["items"] = [];
    for (const belnr of belnrList) {
      const row = tempDocs.find((r) => r.BELNR === belnr);
      if (!row) { console.error(`BELNR ${belnr} not found in temp docs`); process.exit(1); }
      if (row.GRONO) { console.error(`BELNR ${belnr} already has GRONO=${row.GRONO}`); process.exit(1); }
      items.push({
        belnr: row.BELNR,
        budat: row.BUDAT.replace(/-/g, ""),
        bldat: row.BLDAT.replace(/-/g, ""),
        zfbdt: row.ZFBDT.replace(/-/g, ""),
        amountWon: parseInt(row.WRBTR.split(".")[0], 10),
        eviSeqEa: row.EVI_SEQ,
        sgtxt: row.SGTXT,
        rowOverrides: {
          MWSKZ: row.MWSKZ,
          HKONT: row.HKONT,
          HKONT_TXT: row.HKONT_TXT,
          CRD_SEQ: (row as any).CRD_SEQ ?? "",
          EVIKB: row.EVIKB,
          EVIKB_TXT: row.EVIKB_TXT,
        },
      });
    }

    const totalAmount = items.reduce((s, it) => s + it.amountWon, 0);

    const grono = await reserveGronoBatch(ctx, { user, item, items });

    const refUrls = (args["ref-url"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const refKindsRaw = (args["ref-kind"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const refKinds = refUrls.map((_, i) => refKindsRaw[i] ?? refKindsRaw[0] ?? "A");
    const refDocs = refUrls.map((url, i) => {
      const k = refKinds[i];
      if (!["A", "B", "C"].includes(k)) {
        console.error(`--ref-kind must be A/B/C — got '${k}'`); process.exit(1);
      }
      return { URL: url, WF_ITKD: k as "A" | "B" | "C" };
    });

    const res = await submitApproval(ctx, {
      user, item, title: args.title, amountWon: totalAmount,
      grono, attachFiles: [], iBody: args["i-body"],
      refDocs: refDocs.length ? refDocs : undefined,
    });
    console.log(res.message);
    console.log(`GRONO            ${grono}`);
    console.log(`BELNRs           ${belnrList.join(", ")}`);
    console.log(`Total            ₩${totalAmount.toLocaleString()}`);
    console.log(`EVI_SEQ (draft)  ${res.eviSeqDraft}`);
  },
});

/* ── cancel-group ──────────────────────────────────────────────── */

const cancelGroupSub = defineCommand({
  meta: { name: "cancel-group", description: "그룹번호취소 (ZUNIEFI_4202). Releases GRONO from a 회수/반려 전표 so it can be edited or deleted." },
  args: {
    grono: { type: "positional", required: true, description: "GRONO to release" },
  },
  async run({ args }) {
    const { ctx, cfg } = await loadCtx();
    const rows = await listTempDocs(ctx, {
      ...last3MonthsRange(),
      bstat: "V", stats: "*",
    }, cfg.user);
    const row = rows.find((r) => r.GRONO === args.grono);
    if (!row) { console.error(`전표 with GRONO=${args.grono} not found in last 3 months`); process.exit(1); }
    // Allowed states:
    //  C = 회수, R = 반려, 1 = popup-pending (GRONO reserved via ZUNIEFI_4203 but
    //      ApprovalStep never fired — i.e. requestApproval popup opened then closed)
    //  Refuse 2/4/anything else: doc is mid-decision and should be `approval recall`'d first.
    if (!["C", "R", "1"].includes(row.STATS)) {
      console.error(`BELNR ${row.BELNR} STATS=${row.STATS} (${row.STATS_TXT}) — must be 회수(C)/반려(R)/popup-pending(1). For an in-progress doc, use \`approval recall\` first.`);
      process.exit(1);
    }
    await cancelTempDocGroup(ctx, row);
    console.log(`GRONO ${args.grono} canceled. BELNR ${row.BELNR} is now 미상신.`);
  },
});

/* ── delete ────────────────────────────────────────────────────── */

const deleteSub = defineCommand({
  meta: { name: "delete", description: "임시전표삭제 (ZUNIEFI_4103). Wipes a 미상신 BELNR. For 법인카드 entries this also returns the CRD_SEQ to the unprocessed pool so it can be reposted with corrected HKONT/SGTXT." },
  args: {
    belnr: { type: "positional", required: true, description: "BELNR to delete (must be 미상신: GRONO blank)" },
  },
  async run({ args }) {
    const { ctx, cfg } = await loadCtx();
    const rows = await listTempDocs(ctx, {
      ...last3MonthsRange(),
      bstat: "V", stats: "*",
    }, cfg.user);
    const row = rows.find((r) => r.BELNR === args.belnr);
    if (!row) { console.error(`임시전표 BELNR=${args.belnr} not found in last 3 months`); process.exit(1); }
    if (row.GRONO) {
      console.error(`BELNR ${args.belnr} still attached to GRONO ${row.GRONO}.`);
      console.error(`Run \`eac voucher cancel-group ${row.GRONO}\` first to detach it.`);
      process.exit(1);
    }
    await deleteTempDoc(ctx, row);
    console.log(`BELNR ${args.belnr} 임시전표삭제 완료.`);
  },
});

/* ── attach (voucher layer EVI_SEQ) ────────────────────────────── */

const attachNewSub = defineCommand({
  meta: { name: "new", description: "Reserve a new 전표 attachment EVI_SEQ (ZUNIECM_5030 @ legacy menu)." },
  async run() {
    const { ctx } = await loadCtx();
    const seq = await createAttachSeq(ctx, PROG_LEGACY);
    console.log(seq);
  },
});

const attachUploadSub = defineCommand({
  meta: { name: "upload", description: "Upload one or more files to an EVI_SEQ." },
  args: {
    seq: { type: "positional", required: true, description: "EVI_SEQ" },
    files: { type: "positional", required: true, description: "Comma-separated file paths" },
  },
  async run({ args }) {
    const { ctx } = await loadCtx();
    const paths = String(args.files).split(",").map((s) => s.trim()).filter(Boolean);
    await uploadAttachments(ctx, args.seq, paths);
    const sess = await listAttachments(ctx, args.seq);
    console.log(`uploaded ${paths.length}, seq now has ${sess.length} files`);
  },
});

const attachListSub = defineCommand({
  meta: { name: "list", description: "List files on an EVI_SEQ (session.do)." },
  args: {
    seq: { type: "positional", required: true, description: "EVI_SEQ" },
  },
  async run({ args }) {
    const { ctx } = await loadCtx();
    const sess = await listAttachments(ctx, args.seq);
    console.log(`${sess.length} files`);
    for (const f of sess) {
      const used = f.USED === "X" ? "USED" : "    ";
      console.log(`  ${f.FILE_SEQ}  ${used}  ${f.FILE_NAME}  (${f.FILE_SIZE} B)`);
    }
  },
});

const attachCommand = defineCommand({
  meta: { name: "attach", description: "전표 첨부 (EVI_SEQ) primitives." },
  subCommands: { new: attachNewSub, upload: attachUploadSub, list: attachListSub },
});

/* ── voucher namespace ─────────────────────────────────────────── */

export const voucherCommand = defineCommand({
  meta: { name: "voucher", description: "전표 (FI) 조회/작성/결재요청/회수취소." },
  subCommands: {
    list: listSub,
    show: showSub,
    create: createSub,
    "request-approval": requestApprovalSub,
    "request-approval-batch": requestApprovalBatchSub,
    "cancel-group": cancelGroupSub,
    delete: deleteSub,
    attach: attachCommand,
  },
});
