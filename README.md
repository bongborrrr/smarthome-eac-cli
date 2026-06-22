# eac-cli

Generic CLI for `eac.zigbang.in` (E-Accounting / UniDocu).

Drives the UniDocu named-service API directly over HTTP. No headless browser at runtime — auth is just the `JSESSIONID` cookie pulled out of your local browser profile (Chrome by default; Comet/Brave/Edge selectable via `EAC_BROWSER`).

The CLI intentionally stays **domain-agnostic**: it only knows about EAC data and verbs. Company-/personal-specific policy (e.g. *"자기관리비 환급은 영수증 × 70%"*) belongs in your own shell scripts or runbooks.

---

## Install

```sh
npm install -g @zigbang-smarthome/eac-cli
brew install zigbang-smarthome/tap/eac-cli
curl -fsSL https://github.com/zigbang-smarthome/eac-cli/releases/latest/download/install.sh | sh
```

Before first use: open your browser and log in to `https://eac.zigbang.in` at least once so the session cookie lands in your browser's cookie store. The CLI reads that cookie each run.

## Authentication

- EAC uses Google SSO + MS Azure AD SAML — login itself can't be automated. The CLI piggybacks on your normal browser session.
- Each run, `eac` copies the browser's cookie DB to tmpdir, decrypts the `JSESSIONID` for `*.zigbang.in` (AES-128-CBC, key from the `"<Browser> Safe Storage"` Keychain), and pings EAC to confirm the session is alive.
- **Browser selection** — set `EAC_BROWSER` to choose which Chromium-family browser to read from (default: `chrome`):

  | `EAC_BROWSER` | Browser |
  | --- | --- |
  | `chrome` (default) | Google Chrome |
  | `comet` | Comet (Perplexity) |
  | `brave` | Brave |
  | `edge` | Microsoft Edge |

  All share the same cookie format on macOS; only the cookie path and Keychain service name differ. Example: `EAC_BROWSER=comet eac voucher list`.
- **If the session is missing or expired**, the CLI opens the selected browser at `https://eac.zigbang.in/unidocu/view.do` and prompts:
  1. Finish the Google SSO login in the browser.
  2. **Quit the browser (Cmd+Q)** so the new `JSESSIONID` is flushed to disk. Chromium keeps cookies in memory and writes to the SQLite store on a delayed batch schedule — without an explicit quit the CLI may keep reading a stale value.
  3. Return to the terminal and hit Enter — the CLI re-reads the fresh cookie and continues.
  4. Reopen the browser normally afterwards.

  Tip: turn on the browser's *"Continue where you left off"* startup option so the session cookie survives the Cmd+Q cycle. EAC re-login becomes infrequent (only when the SAP-side session truly expires).
- macOS may prompt for Keychain access the first time (click *Always Allow*).
- Override: set `EAC_JSESSIONID=<value>` to bypass the keychain entirely and use a cookie sourced elsewhere (e.g. extracted from Playwright/CDP-controlled browser). Useful when EAC is open in a non-default profile or in CI scripts.
- Non-TTY environments (CI, piped scripts) error out instead of prompting — pass `EAC_JSESSIONID` explicitly there.

---

## Concept model

Before the commands it helps to see the data model the CLI talks to. UniDocu has **two related document spaces** and **two separate attachment layers**.

### 두 문서 공간

| 공간 | 식별자 | UI 메뉴 | Backend service prefix |
|------|--------|---------|------------------------|
| **전표 (FI)** | `BELNR` (SAP 문서번호) | 비용정산 › 개인비용 › EA전표결재 (`UD_0302_000`) | `ZUNIEFI_*` |
| **결재문서 (WF)** | `GRONO` (그룹번호) + `WF_KEY` | 결재함 (`UFL_0401_020` 등) | `ZUNIEWF_*` |

하나의 전표(BELNR)에 결재요청을 걸면 결재문서(GRONO)가 예약돼 전표에 붙는다. 관계는 1:1.

### 두 첨부 레이어 — **결재자 입장에서 달라 보인다**

같은 영수증 PDF를 올리더라도 **어느 레이어에 붙이느냐**가 결재자 UX를 가른다.

1. **전표 레이어** (`voucher attach`) — `ZUNIEFI_4006` 저장 시 함께 연결됨. 세무/회계팀이 전표 상세뷰에서 확인.
2. **결재문서 레이어** (`approval attach`) — `ApprovalStep` body의 `EVI_SEQ` 필드로 전달됨. **이게 있어야 결재함 리스트에서 `📎` 아이콘이 뜬다** (`WF_ATTACH_FLAG = X`). 없으면 결재자 입장에서 "첨부 없는 문서"로 보임.

`voucher create` 는 1번 레이어에, `voucher request-approval` 은 2번 레이어에 각각 올린다. 두 명령 모두 `--attach-dir`를 받아 같은 영수증 폴더를 두 번 올림. (같은 파일의 중복 업로드는 서버 저장소에 별개 기록으로 남는다.)

### 11-step 상세 (참고)

1. `ZUNIEFI_4003` — 기본값 계산 (ZFBDT 등)
2. `ZUNIECM_5030` — 전표 레이어 EVI_SEQ 채번
3. `fineuploader/request.do` — 전표 레이어에 파일 업로드
4. `ZUNIEFI_4006` — 비용항목 저장 (EVI_SEQ 연결)
5. `ZUNIEFI_5000` — SAP posting → BELNR 발급
6. `ZUNIEFI_4203` — GRONO 예약 (아직 상신 아님)
7. `ZUNIECM_5030` — 결재 레이어 EVI_SEQ 채번
8. `fineuploader/request.do` — 결재 레이어에 파일 업로드
9. `ZUNIEWF_2200` — 개인결재선 목록 조회
10. `ZUNIEWF_4101` — 결재자 리스트 조회
11. `ApprovalStep` (targetNamedServiceId `ZUNIEWF_4201`) — 최종 상신

1~5 = `voucher create`, 6~11 = `voucher request-approval`.

---

## Command reference

```
eac
├── voucher            전표 (FI, ZUNIEFI_*)
│   ├── list                       ZUNIEFI_4200
│   ├── show <BELNR|GRONO>         ZUNIEFI_4207
│   ├── create                     전표 작성 (Steps 1-5 → BELNR)
│   ├── request-approval <BELNR>   결재요청 (Steps 6-11 → GRONO + 상신)
│   ├── cancel-group <GRONO>       그룹번호취소 (ZUNIEFI_4202)
│   ├── delete <BELNR>             임시전표삭제 (ZUNIEFI_4103)
│   └── attach new|upload|list     전표 레이어 EVI_SEQ primitive
├── corpcard          법인카드(공용) — 카드사 거래 → 임시전표
│   ├── list                       ZUNIEFI_1000 (미정산 거래)
│   └── create <CRD_SEQ>           ZUNIEFI_4006 + ZUNIEFI_1009 → BELNR
├── approval           결재문서 (WF, ZUNIEWF_*)
│   ├── list [--box]               ZUNIEWF_4500 (결재함)
│   ├── recall <GRONO>             회수 (ApprovalStep + ZUNIEWF_4320)
│   ├── attach new|upload|list     결재 레이어 EVI_SEQ primitive
│   └── line
│       ├── list                          ZUNIEWF_2200 (개인결재선 목록)
│       ├── show <SEQ> [--json]           ZUNIEWF_2203 (결재선 + 결재자)
│       ├── approvers <SEQ> --grono <G>   ZUNIEWF_4101 (특정 GRONO용)
│       ├── save <SEQ> <approvers.json>   ZUNIEWF_2201 (결재자 통째 저장)
│       ├── add <SEQ> <user> [--at lev]   사용자 추가 (read → splice → save)
│       ├── remove <SEQ> <level|wf_id>    결재자 제거 (read → splice → save)
│       └── search-user <name>            ZUNIEWF_1035 (이름으로 EAC 사용자 검색)
├── call <id> --prog [--data]      raw named-service escape hatch
└── config show|init               ~/.config/eac/config.json
```

### `eac voucher`

**`voucher list`** — `ZUNIEFI_4200`. 기본은 현재 월, `BSTAT=V` (임시전표). `--bstat *`로 전체, `--stats`로 미상신/진행중/승인/회수/반려 필터.

**`voucher show <BELNR|GRONO>`** — `ZUNIEFI_4207`. BELNR/GRONO 아무 거나 받아 상세 표시 (BELNR은 서버 3-개월 조회 윈도우 내에서 자동 resolve).

**`voucher create`** — 전표 작성. Steps 1-5. BELNR 반환. 아직 GRONO 없음 (결재 전).
```
--item <name>        Preset name from config.items (e.g. "자기관리비")
--title <text>       전표 제목 (SGTXT)
--bldat <YYYYMMDD>   영수증 날짜
--budat <YYYYMMDD>   전기일자 (default: today)
--amount <won>       금액 (정수)
--attach-dir <path>  첨부 폴더 (optional)
```

**`voucher request-approval <BELNR>`** — 결재요청. Steps 6-11. GRONO 발급 + 실제 상신. `--attach-dir` 필수 (결재 레이어 첨부).

**`voucher cancel-group <GRONO>`** — 그룹번호취소 (`ZUNIEFI_4202`). 회수(`STATS=C`) 또는 반려(`STATS=R`)된 전표에 붙은 GRONO를 풀어준다. 풀린 BELNR은 다시 결재요청 가능 (수정 사항이 없으면 `request-approval`로 바로 재상신, HKONT/적요 등 수정해야 한다면 `delete` 후 새로 `create`).

**`voucher delete <BELNR>`** — 임시전표삭제 (`ZUNIEFI_4103`). GRONO가 비어있는(미상신) 임시전표를 완전 삭제한다. 법인카드 정산 건이라면 원래의 카드 거래(`CRD_SEQ`)가 미정산 풀로 돌아와 `corpcard list`/`corpcard create`로 다시 잡을 수 있다. GRONO가 붙어있으면 먼저 `cancel-group`을 거쳐야 한다.

**`voucher attach {new, upload, list}`** — 전표 레이어 EVI_SEQ 직접 조작 (보통 `create`가 자동 처리하므로 쓸 일 많지 않음).

### `eac corpcard`

법인카드(공용) 사용내역을 카드사 데이터 기반으로 임시전표화한다. 자기관리비/일반경비와 달리 영수증을 직접 첨부하지 않는다 (카드사가 SAP 후단에 거래 데이터로 자동 첨부).

**`corpcard list [--from] [--to] [--merch]`** — 미정산 카드 거래 목록 (`ZUNIEFI_1000`). 이미 전표화된 거래는 빠진다. 각 행이 `CRD_SEQ`로 식별됨.

**`corpcard create <CRD_SEQ> --hkont --remark [--budat] [--bldat]`** — 카드 거래를 임시전표로 변환 (`ZUNIEFI_4006` + `ZUNIEFI_1009` → BELNR). 첨부 EVI_SEQ 호출 없음.

```
--hkont <code>       G/L 계정 (예: 52010102 회식대 / 52060101 회의비 / 52050104 접대비-신용카드 / 52030203 시내교통비)
--hkont-text <name>  표기용 (옵션)
--remark <text>      적요. 형식: [법인카드/거래처/참석자] 또는 [법인카드/출발→도착]
--budat <YYYYMMDD>   전기일 (default: today; 결제월 마감 후엔 익월 1일 강제)
--bldat <YYYYMMDD>   증빙일 (default: 카드 승인일)
```

발급된 BELNR은 그대로 `eac voucher request-approval <BELNR> --item 법인카드 --title "..."`로 결재요청. 결재선은 `[개인]-일반경비` 그대로 (`성민지 → Leah Song`).

> 참고: 법인카드는 회사 정책상 부가세 V3 (불공제 매입세액)을 강제로 적용. EVIKB=FI_12 (법인카드기명식). MWSKZ/EVIKB는 코드에서 자동 세팅.

### `eac approval`

**`approval list [--box progress|approved|rejected|pending]`** — `ZUNIEWF_4500`. 📎 표시로 결재 레이어 첨부 유무 한눈에 보임.

**`approval recall <GRONO>`** — 진행중 결재문서 회수. 내부는 `ApprovalStep` + `targetNamedServiceId=ZUNIEWF_4320` + `APPR_STAT=E`.

**`approval attach {new, upload, list}`** — 결재 레이어 EVI_SEQ 직접 조작 (보통 `request-approval`이 자동 처리).

**`approval line list`** — 개인결재선 목록 (`ZUNIEWF_2200`).

**`approval line show <SEQ>`** — 결재선의 결재자를 그 자체로 조회 (`ZUNIEWF_2203`). `--json`을 붙이면 raw 배열을 출력 — 그대로 `line save` 입력으로 사용 가능.

**`approval line approvers <SEQ> --grono <G>`** — 특정 결재문서(GRONO)에 묶인 결재자 평가 결과 (`ZUNIEWF_4101`). 결재선 자체보다는 *그 문서가 진짜 누구를 거치는가*를 본다.

**`approval line save <SEQ> <approvers.json>`** — 결재자 리스트 통째 저장 (`ZUNIEWF_2201`). 파일은 `line show --json` 출력 형식.

**`approval line add <SEQ> <name|wf_id> [--at lev]`** — 결재선에 사용자 한 명 추가. `<name>`이면 `ZUNIEWF_1035`로 검색해 단일 매칭일 때만 진행. `--at`은 1-based 위치 (없으면 끝에 추가). 내부적으로 `show → splice → save`.

**`approval line remove <SEQ> <level|wf_id>`** — 결재선에서 한 명 제거. 숫자면 1-based level, 아니면 `WF_ID` (예: `ZB01010`)로 매칭.

**`approval line search-user <name>`** — EAC 사용자 검색 (`ZUNIEWF_1035`). 한글/영문 단편 모두 가능.

> 결재선 **생성/삭제** 자체는 아직 자동화 안 됨 (수동 UI에서 한 번도 캡쳐 안 잡힘). 새 라인이 필요하면 EAC UI에서 생성한 뒤 `add/remove`/`save`로 결재자만 자동화.

### `eac call`

Wrapping 없는 서비스 직접 호출용 escape hatch.

```sh
eac call ZUNIEFI_4207 --prog DRAFT_0010 --data '{"GRONO":"FI20260000023922"}'
```

### `eac config`

- `config show` — 현재 config JSON 프린트
- `config init` — `~/.config/eac/config.json` 없으면 기본값 생성
- `user.gsber` — 사업영역(business area). **비용센터(`user.kostl`)와 일치**시켜야 한다. EAC는 전표의 차변/대변 사업영역이 다르면 거부한다(`Please input only the same 'Business Area'`, ZUNIEFI_1009). 미설정 시 `K200`으로 fallback하므로, 비용센터가 K300 영역(e.g. `343000`)이면 `gsber: "K300"`을 반드시 설정한다.

---

## Standard flow — 2 steps

eac-cli는 "전표 작성 + 결재요청 한 번에"라는 composite를 **일부러 제공하지 않는다**. 중간에 실패하면 상태(BELNR 발급됐는데 GRONO 없음)가 숨겨져 복구가 어려워지기 때문. 필요하면 shell script로 2 단계를 명시적으로 조합.

```sh
# Step 1: 전표 작성
BELNR=$(eac voucher create \
  --item  "자기관리비" \
  --title "2026년 5월 자기관리비" \
  --bldat 20260503 \
  --amount 30800 \
  --attach-dir ./자기관리비/202605 \
  | awk '/^BELNR/ {print $2}')
echo "BELNR=$BELNR"

# Step 2: 결재요청
eac voucher request-approval "$BELNR" \
  --item  "자기관리비" \
  --title "2026년 5월 자기관리비" \
  --attach-dir ./자기관리비/202605
```

이걸 그대로 월별 task script로 감싸서 `~/bin/` 또는 repo의 `scripts/`에 두면 됨:

```sh
#!/usr/bin/env bash
# scripts/자기관리비-상신.sh
set -euo pipefail
month="$1"; bldat="$2"; receipt="$3"
y="${month:0:4}"; m=$((10#${month:4:2}))
title="${y}년 ${m}월 자기관리비"
amount=$(( receipt * 7 / 10 ))
dir="./자기관리비/${month}"

BELNR=$(eac voucher create --item "자기관리비" --title "$title" \
  --bldat "$bldat" --amount "$amount" --attach-dir "$dir" \
  | awk '/^BELNR/ {print $2}')

eac voucher request-approval "$BELNR" --item "자기관리비" \
  --title "$title" --attach-dir "$dir"
```

## Recovery flows

### 상신 후 실수 발견 → 회수하고 재상신

```sh
# 예: 23922 상신했는데 영수증 잘못 넣었음
eac approval recall       FI20260000023922
eac voucher cancel-group  FI20260000023922

# 이제 BELNR 3200005520 은 "미상신" 상태. 다시 결재요청 가능:
eac voucher request-approval 3200005520 \
  --item  "자기관리비" \
  --title "2026년 5월 자기관리비 (수정)" \
  --attach-dir ./자기관리비/202605
```

### 아이템 자체를 잘못 골랐을 때 (FI_22 → FI_21)

전표(BELNR)는 `HKONT`/`EVIKB` 확정 후 SAP에 posting되므로 item을 바꾸려면 **새 전표 필요**. 기존 것은 회수 → 그룹번호취소 → 임시전표삭제 후 새로 create:

```sh
# 잘못된 item
eac approval recall       FI20260000023877
eac voucher cancel-group  FI20260000023877
eac voucher delete        3200005641   # 임시전표 완전 삭제

# 올바른 item 으로 새로 시작
BELNR=$(eac voucher create --item "자기관리비" ...)
eac voucher request-approval "$BELNR" --item "자기관리비" ...
```

### 법인카드: 반려된 후 HKONT 잘못 골랐던 경우

`회식대(52010102)` 와 `회의비(52060101)` 처럼 잘못 분류했다가 회계팀 반려를 받았을 때. 카드 거래(`CRD_SEQ`)는 살리고 HKONT/적요만 다시 잡으면 된다.

```sh
# 1) 반려 결재문서의 GRONO 풀어내기
eac voucher cancel-group  FI20260000023988    # GRONO 가 붙어있던 회수/반려 전표 detach

# 2) 임시전표 자체를 삭제 → CRD_SEQ 가 미정산 풀로 복귀
eac voucher delete        3200005642

# 3) 카드 거래 다시 잡기 (CRD_SEQ 그대로 — list 로 확인)
eac corpcard list --merch 이마트24
BELNR=$(eac corpcard create 20260421001000020116 \
  --hkont 52010102 \
  --hkont-text "판)복리후생비-회식대" \
  --remark "[법인카드/이마트24청담리테일점/박영걸, 오현아]")

# 4) 결재요청
eac voucher request-approval "$BELNR" --item 법인카드 --title "[법인카드/...]"
```

> 💡 회계팀 룰: 참석자가 **전원 직원**이면 회식대(`52010102`), **외부인 1명 이상** + 사전 회의 기안서가 있어야만 회의비(`52060101`).

### 조회 / 디버깅

```sh
eac voucher list                 # 내 임시전표
eac voucher list --bstat '*' --stats '*'   # 전체
eac voucher show FI20260000023922
eac approval list                 # 진행중
eac approval list --box rejected  # 반려/회수

# 결재선 구조 확인
eac approval line list
eac approval line approvers 0000000002 --grono FI20260000023922
```

---

## Config

`~/.config/eac/config.json`. 한 번 설정하고 `--item <name>` 으로 재사용.

```json
{
  "user": {
    "pernr": "ZB01135",
    "bukrs": "K001",
    "pernrName": "박영걸",
    "wfIdText": "YG Park (박영걸)",
    "kostl": "226020",
    "kostlText": "Device Engineering",
    "wfDept": "0000252100",
    "wfDeptText": "Service Engineering"
  },
  "items": {
    "자기관리비": {
      "hkont": "52010108",
      "hkontText": "판)복리후생비-자기관리비",
      "evikb": "FI_21",
      "evikbText": "장려지원금",
      "wfLineSeq": "0000000002",
      "wfLineLin1": "0000000816"
    }
  }
}
```

새 item 추가 시 필요한 값:
- `hkont` — G/L 계정 (e.g. `52010177` 판)복리후생비-기타)
- `evikb` — 전표 종류 코드 (e.g. `FI_21` 장려지원금, `FI_22` 일반경비)
- `wfLineSeq` / `wfLineLin1` — 해당 item의 개인결재선 (참고: `eac approval line list`로 확인)

Preset key는 한글 이름(`자기관리비`, `가족식사비`, `원격근무지원비`, …) 사용 권장.

---

## Development

```sh
bun install
bun run src/index.ts --help
```

Release: `gh workflow run release.yml` — oneup가 version bump + npm/Homebrew publish 자동화.

## License

MIT
