/**
 * 거래내역 화면. 수집 클라이언트가 파싱할 대상이다.
 *
 * 두 가지가 이 파일의 전부다.
 *
 * 1. **결정론적 데이터.** 난수를 쓰면 같은 계좌를 두 번 긁은 결과가 달라져서
 *    "몇 건 수집했나"가 측정값이 되지 못한다. 계좌번호와 순번만으로 값을 만든다.
 * 2. **EUC-KR 응답.** 국내 금융권 화면이 아직 이 인코딩으로 내려오는 곳이 있다.
 *    Node 내장 `TextEncoder`는 `euc-kr` 레이블을 받아도 무시하고 UTF-8을 내므로
 *    (`new TextEncoder('euc-kr').encoding === 'utf-8'`) `iconv-lite`로 인코딩한다.
 */

import iconv from 'iconv-lite';

export type Transaction = {
  seq: number;
  /** `YYYY-MM-DD HH:mm:ss`. UTC로 계산하고 UTC로 찍는다. 실행 환경 시간대에 따라
   *  값이 달라지면 결정론이 깨진다. */
  at: string;
  memo: string;
  withdrawal: number;
  deposit: number;
  balance: number;
};

export type TransactionPage = {
  accountNo: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  rows: readonly Transaction[];
};

export const PAGE_SIZE = 20;

/** 첫 거래 시각. 고정값이라야 같은 계좌가 언제 조회해도 같은 내역을 준다. */
const LEDGER_START_MS = Date.UTC(2026, 0, 2, 0, 0, 0);
const STEP_MS = 6 * 60 * 60 * 1000;
const OPENING_BALANCE = 3_250_000;

/**
 * 적요는 방향과 묶는다. 해시로 적요와 입출금을 따로 고르면 "카드대금 입금"
 * 같은 행이 나온다. 파싱만 보면 멀쩡하지만 화면으로는 말이 안 되고, 금융
 * 도메인 화면을 모사한다면서 도메인을 안 본 티가 그대로 난다.
 */
const DEPOSIT_MEMOS = ['급여', '이자', '계좌이체', '환급'] as const;
const WITHDRAWAL_MEMOS = ['카드대금', 'ATM출금', '관리비', '통신요금', '보험료'] as const;

/**
 * FNV-1a 32비트 해시.
 *
 * 암호용이 아니다. 같은 입력에 같은 숫자를 돌려주기만 하면 되고, 짧아서 이
 * 파일만 읽어도 무엇이 나오는지 따라갈 수 있다.
 */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const ledgerCache = new Map<string, readonly Transaction[]>();

/**
 * 계좌 전체 내역을 만든다. 잔액이 누적이라 앞에서부터 전부 계산해야 하고,
 * 한 번 만들면 바뀌지 않으므로 계좌별로 기억해 둔다.
 */
export function buildLedger(accountNo: string, count: number): readonly Transaction[] {
  const key = `${accountNo}#${count}`;
  const cached = ledgerCache.get(key);
  if (cached !== undefined) return cached;

  const rows: Transaction[] = [];
  let balance = OPENING_BALANCE;

  for (let seq = 1; seq <= count; seq += 1) {
    const h = hash32(`${accountNo}:${seq}`);
    const withdrawalAmount = (((h >>> 8) % 900) + 1) * 1000;

    // 출금이 잔액을 음수로 만들 차례면 입금으로 뒤집는다. **직전 잔액만** 보므로
    // 앞에서부터 계산하는 한 결과는 그대로 결정론이다. 이걸 안 하면 137건 중
    // 125건이 음수가 되고 첫 화면부터 마이너스 잔액이 보인다.
    const isDeposit = h % 3 === 0 || balance - withdrawalAmount < 0;
    const amount = isDeposit ? (((h >>> 8) % 1800) + 200) * 1000 : withdrawalAmount;

    // as: as const 배열이라 나머지 연산 결과가 범위를 벗어날 수 없다.
    // noUncheckedIndexedAccess는 그걸 모르므로 여기서만 좁혀 준다.
    const memo = (
      isDeposit
        ? DEPOSIT_MEMOS[(h >>> 4) % DEPOSIT_MEMOS.length]
        : WITHDRAWAL_MEMOS[(h >>> 4) % WITHDRAWAL_MEMOS.length]
    ) as string;

    const at = new Date(LEDGER_START_MS + (seq - 1) * STEP_MS + ((h >>> 20) % 21_600) * 1000);

    balance += isDeposit ? amount : -amount;
    rows.push({
      seq,
      at: at.toISOString().slice(0, 19).replace('T', ' '),
      memo,
      withdrawal: isDeposit ? 0 : amount,
      deposit: isDeposit ? amount : 0,
      balance,
    });
  }

  const frozen: readonly Transaction[] = rows;
  ledgerCache.set(key, frozen);
  return frozen;
}

export function selectPage(accountNo: string, count: number, page: number): TransactionPage {
  const ledger = buildLedger(accountNo, count);
  const start = (page - 1) * PAGE_SIZE;
  return {
    accountNo,
    page,
    pageSize: PAGE_SIZE,
    total: ledger.length,
    // 0건이어도 1페이지는 있다. 총 페이지가 0이면 "1페이지를 달라"는 요청이
    // 범위 밖이 되어 빈 목록과 잘못된 요청을 구분할 수 없다.
    totalPages: Math.max(1, Math.ceil(ledger.length / PAGE_SIZE)),
    rows: ledger.slice(start, start + PAGE_SIZE),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function won(amount: number): string {
  // U+FFE6 FULLWIDTH WON SIGN을 쓴다. 흔히 쓰는 U+20A9(₩)는 EUC-KR(CP949)에
  // 없어서 iconv-lite가 예외 없이 '?'(0x3F)로 바꿔 버린다. 바이트만 보면
  // 정상이라 파싱 단계까지 통과하고, 금액 옆 글자가 깨진 채로 저장된다.
  return amount === 0 ? '' : `￦${amount.toLocaleString('en-US')}`;
}

/**
 * 조회 결과를 HTML로 만든다.
 *
 * `data-total`과 `data-page`를 요약 줄에 싣는 것이 이 함수의 요점이다. 이게
 * 없으면 수집하는 쪽에서 **빈 페이지**(정상인데 더 볼 게 없음)와 **파싱 실패**
 * (구조가 바뀌어 행을 못 찾음)가 똑같이 "0건"으로 보인다. 둘을 못 나누면
 * 차단 없는 기준선 성공률이 100%로 나오지 않고, 그러면 비교할 기준이 없어진다.
 *
 * 그래서 마지막 페이지 이후라도 표 구조는 그대로 두고 `tbody`만 비운다.
 */
export function renderTransactionsHtml(page: TransactionPage): string {
  const rows = page.rows
    .map(
      (tx) => `      <tr data-seq="${tx.seq}">
        <td class="at">${escapeHtml(tx.at)}</td>
        <td class="memo">${escapeHtml(tx.memo)}</td>
        <td class="withdrawal">${escapeHtml(won(tx.withdrawal))}</td>
        <td class="deposit">${escapeHtml(won(tx.deposit))}</td>
        <td class="balance">${escapeHtml(won(tx.balance))}</td>
      </tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="euc-kr">
  <title>거래내역 조회</title>
</head>
<body>
  <p id="summary" data-account="${escapeHtml(page.accountNo)}" data-total="${page.total}" data-page="${page.page}" data-page-size="${page.pageSize}" data-total-pages="${page.totalPages}">
    계좌 ${escapeHtml(page.accountNo)} · 전체 ${page.total}건 · ${page.page} / ${page.totalPages} 페이지
  </p>
  <table id="transactions">
    <thead>
      <tr><th>거래일시</th><th>적요</th><th>출금</th><th>입금</th><th>잔액</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>
`;
}

export const TRANSACTIONS_CONTENT_TYPE = 'text/html; charset=euc-kr';

export function encodeEucKr(html: string): Buffer {
  return iconv.encode(html, 'euc-kr');
}
