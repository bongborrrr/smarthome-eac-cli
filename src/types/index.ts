/**
 * Shared types for the EAC CLI.
 *
 * The EAC (UniDocu) APIs expose SAP fields directly. Many types here mirror those
 * — keep key names exactly as the server expects (uppercase SAP aliases).
 */

export interface UserProfile {
  pernr: string;         // Employee number, e.g. "ZB01135"
  bukrs: string;         // Company code, e.g. "K001"
  pernrName: string;     // Display name, e.g. "박영걸"
  wfIdText: string;      // Full display like "YG Park (박영걸)"
  kostl: string;         // Cost center, e.g. "226020"
  kostlText: string;     // "Device Engineering"
  /**
   * Business area (사업영역), e.g. "K200" / "K300". MUST match the cost center —
   * EAC rejects vouchers whose debit/credit business areas differ (ZUNIEFI_1009).
   * Optional for backward compat; falls back to "K200" when absent.
   */
  gsber?: string;
  wfDept: string;        // Department code
  wfDeptText: string;    // "Service Engineering"
}

export interface ReimbursementItem {
  /** G/L account (e.g. "52010108" = 자기관리비). */
  hkont: string;
  hkontText: string;      // "판)복리후생비-자기관리비"
  /** Document type code (e.g. "FI_21" = 장려지원금). */
  evikb: string;
  evikbText: string;      // "장려지원금"
  /** personal approval line SEQ — e.g. "0000000002" for [개인]-장려지원금. */
  wfLineSeq: string;
  wfLineLin1: string;
}

export interface ApprovalLine {
  SELECTED: string;
  WF_LINE_LEV: number;
  WF_SEQ: string;
  DISPLAY_TEXT: string;
  WF_AGREE: string;
  [k: string]: unknown;
}
