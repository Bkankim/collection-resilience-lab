/**
 * 거래내역 화면(EUC-KR HTML)을 읽어 거래 목록으로 만든다.
 *
 * HTML 파서 의존성을 붙이지 않고 정규식으로 읽는다. 대상 마크업은 우리가 만든
 * 것이고, 구조가 바뀌면 여기서 조용히 적응하기보다 PARSE_FAILED로 드러나는 편이
 * 정직하다. 관대한 파서는 구조 변경을 "행이 조금 적은 정상 응답"으로 바꿔 버린다.
 *
 * 그래서 이 파일은 읽는 것만큼 **의심하는 것**이 일이다. 요약 줄의 숫자와 실제
 * 행 수가 맞는지까지 본다. 안 보면 행을 절반만 읽은 페이지가 성공으로 올라간다.
 */

import iconv from 'iconv-lite';

/** 대상 서버의 `Transaction`과 같은 모양. 대상 코드를 import하지 않는 이유는
 *  수집기가 대상 서버를 모르는 외부 클라이언트여야 측정이 정직해서다. */
export type Transaction = {
  seq: number;
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
  rows: Transaction[];
};

export type ParseResult = { ok: true; page: TransactionPage } | { ok: false; detail: string };

/**
 * EUC-KR로 디코딩했을 때 나오면 안 되는 글자. iconv-lite는 해석할 수 없는 바이트를
 * 예외 없이 U+FFFD로 바꾼다. 이걸 안 보면 인코딩이 바뀐 응답에서 숫자는 멀쩡히
 * 읽히고 적요만 깨진 채로 저장된다.
 */
const REPLACEMENT_CHAR = '\uFFFD';

export function decodeEucKr(body: Buffer): string {
  return iconv.decode(body, 'euc-kr');
}

export function parseTransactionsHtml(body: Buffer): ParseResult {
  const html = decodeEucKr(body);
  if (html.includes(REPLACEMENT_CHAR)) {
    return { ok: false, detail: 'EUC-KR로 디코딩할 수 없는 바이트가 있다' };
  }

  const summary = readSummary(html);
  if (!summary.ok) return summary;

  const tbody = readTbody(html);
  if (!tbody.ok) return tbody;

  const rows = readRows(tbody.value);
  if (!rows.ok) return rows;

  const { accountNo, page, pageSize, total, totalPages } = summary.value;
  // 대상 서버는 0건이어도 1페이지를 준다(`max(1, ceil(total / pageSize))`). 이게
  // 어긋나면 수집하는 쪽의 "다음 페이지가 있나" 판단이 틀려진다.
  const pagesFromTotal = Math.max(1, Math.ceil(total / pageSize));
  if (pagesFromTotal !== totalPages) {
    return { ok: false, detail: `요약의 totalPages=${totalPages}가 total=${total}, pageSize=${pageSize}로 계산한 ${pagesFromTotal}와 다르다` };
  }

  const expected = expectedRowCount(summary.value);
  if (rows.value.length !== expected) {
    // 요약 줄과 행 수가 어긋나면 둘 중 하나는 틀렸다. 어느 쪽인지 여기서는 모르므로
    // 성공으로 올리지 않는다. 행을 덜 읽은 페이지가 성공이 되면 누락이 측정에 묻힌다.
    return {
      ok: false,
      detail: `행 수가 요약과 맞지 않는다: 읽은 행 ${rows.value.length}, 요약으로 계산한 행 ${expected} (total=${total} page=${page} pageSize=${pageSize})`,
    };
  }

  return { ok: true, page: { accountNo, page, pageSize, total, totalPages, rows: rows.value } };
}

type Summary = Omit<TransactionPage, 'rows'>;

type Step<T> = { ok: true; value: T } | { ok: false; detail: string };

/** 이 페이지에 있어야 할 행 수. 마지막 페이지 이후는 0이 맞다. */
function expectedRowCount(s: Summary): number {
  const remaining = s.total - (s.page - 1) * s.pageSize;
  return Math.min(s.pageSize, Math.max(0, remaining));
}

function readSummary(html: string): Step<Summary> {
  const tag = /<p\s+id="summary"([^>]*)>/.exec(html);
  if (tag === null) return { ok: false, detail: '요약 줄(#summary)이 없다' };
  const attrs = tag[1] ?? '';

  const accountNo = readAttr(attrs, 'data-account');
  if (accountNo === undefined || accountNo === '') {
    return { ok: false, detail: '요약 줄에 data-account가 없다' };
  }

  const numbers: Record<'total' | 'page' | 'pageSize' | 'totalPages', number> = {
    total: 0,
    page: 0,
    pageSize: 0,
    totalPages: 0,
  };
  const names = {
    total: 'data-total',
    page: 'data-page',
    pageSize: 'data-page-size',
    totalPages: 'data-total-pages',
  } as const;
  for (const key of Object.keys(names) as (keyof typeof names)[]) {
    const raw = readAttr(attrs, names[key]);
    // `Number('')`는 0이고 `Number(' 3')`은 3이다. 숫자로 보이는 모든 것을 받으면
    // 깨진 값이 조용히 0이 되므로 자릿수만 받는다.
    if (raw === undefined || !/^\d+$/.test(raw)) {
      return { ok: false, detail: `요약 줄의 ${names[key]} 값이 숫자가 아니다: ${JSON.stringify(raw ?? null)}` };
    }
    numbers[key] = Number(raw);
  }
  // 페이지와 페이지 크기가 0이면 행 수 계산이 뜻을 잃는다. 대상 서버는 1부터 준다.
  if (numbers.page < 1 || numbers.pageSize < 1 || numbers.totalPages < 1) {
    return { ok: false, detail: '요약 줄의 page/pageSize/totalPages는 1 이상이어야 한다' };
  }

  return { ok: true, value: { accountNo: unescapeHtml(accountNo), ...numbers } };
}

function readAttr(attrs: string, name: string): string | undefined {
  // `data-page`가 `data-page-size`에 걸리지 않도록 이름 앞뒤를 경계로 자른다.
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return match?.[1];
}

function readTbody(html: string): Step<string> {
  const table = /<table\s+id="transactions"[^>]*>([\s\S]*?)<\/table>/.exec(html);
  if (table === null) return { ok: false, detail: '거래 표(table#transactions)가 없다' };
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(table[1] ?? '');
  if (tbody === null) return { ok: false, detail: '거래 표에 tbody가 없다' };
  return { ok: true, value: tbody[1] ?? '' };
}

const CELL_CLASSES = ['at', 'memo', 'withdrawal', 'deposit', 'balance'] as const;
type CellClass = (typeof CELL_CLASSES)[number];

function readRows(tbody: string): Step<Transaction[]> {
  const rows: Transaction[] = [];

  // `data-seq` 없는 `<tr>`이 섞이면 아래 정규식은 그 행을 건너뛴다. 그러면 행
  // 누락이 조용히 일어나므로, 모든 `<tr`을 먼저 세어 둘을 맞춰 본다.
  const allTr = tbody.match(/<tr\b/g)?.length ?? 0;

  for (const match of tbody.matchAll(/<tr data-seq="(\d+)">([\s\S]*?)<\/tr>/g)) {
    const seq = Number(match[1]);
    const cells = readCells(match[2] ?? '');
    if (!cells.ok) return { ok: false, detail: `seq ${seq}: ${cells.detail}` };

    const at = unescapeHtml(cells.value.at);
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at)) {
      return { ok: false, detail: `seq ${seq}: 거래일시 형식이 다르다: ${JSON.stringify(at)}` };
    }

    const withdrawal = readAmount(cells.value.withdrawal, false);
    const deposit = readAmount(cells.value.deposit, false);
    const balance = readAmount(cells.value.balance, true);
    if (withdrawal === undefined || deposit === undefined || balance === undefined) {
      return { ok: false, detail: `seq ${seq}: 금액을 읽을 수 없다` };
    }

    rows.push({ seq, at, memo: unescapeHtml(cells.value.memo), withdrawal, deposit, balance });
  }

  if (rows.length !== allTr) {
    return { ok: false, detail: `tbody의 tr ${allTr}개 중 ${rows.length}개만 거래 행 형식이다` };
  }
  return { ok: true, value: rows };
}

function readCells(tr: string): Step<Record<CellClass, string>> {
  const found = new Map<string, string>();
  for (const match of tr.matchAll(/<td class="([^"]*)">([^<]*)<\/td>/g)) {
    const cls = match[1] ?? '';
    if (found.has(cls)) return { ok: false, detail: `칸 ${cls}이 두 번 나온다` };
    found.set(cls, match[2] ?? '');
  }
  const cells = {} as Record<CellClass, string>;
  for (const cls of CELL_CLASSES) {
    const value = found.get(cls);
    if (value === undefined) return { ok: false, detail: `칸 ${cls}이 없다` };
    cells[cls] = value;
  }
  return { ok: true, value: cells };
}

/**
 * `￦1,234,000` → 1234000. 빈 칸은 0이다. 대상 서버는 0원을 빈 칸으로 그린다.
 *
 * 원화 기호는 U+FFE6만 받는다. U+20A9(₩)는 EUC-KR에 없어서 대상 서버가 쓰지 않고,
 * 쓴다면 인코딩 단계에서 `?`로 바뀌어 온다. 그걸 받아 주면 깨진 응답이 통과한다.
 * 음수는 잔액에만 허용한다. 출금·입금이 음수인 행은 말이 안 된다.
 */
function readAmount(cell: string, allowNegative: boolean): number | undefined {
  const text = unescapeHtml(cell).trim();
  if (text === '') return 0;
  const match = /^\uFFE6(-?)(\d{1,3}(?:,\d{3})*)$/.exec(text);
  if (match === null) return undefined;
  if (match[1] === '-' && !allowNegative) return undefined;
  const value = Number((match[2] ?? '').replace(/,/g, ''));
  return match[1] === '-' ? -value : value;
}

/** 대상 서버 `escapeHtml`의 역변환. `&amp;`를 마지막에 풀어야 `&amp;lt;`가 `<`가 되지 않는다. */
function unescapeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
