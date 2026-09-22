/**
 * 거래내역 파서 테스트.
 *
 * 입력은 손으로 쓴 문자열이 아니라 대상 서버의 렌더러와 인코더가 만든 실제 바이트다.
 * 손 문자열로 테스트하면 UTF-8로 쓴 한글을 EUC-KR로 읽는 결함이 테스트 안에서는
 * 절대 드러나지 않는다.
 */

import { describe, expect, it } from 'vitest';

import { DEMO_ACCOUNTS } from '../../target/accounts.js';
import { buildLedger, encodeEucKr, renderTransactionsHtml, selectPage } from '../../target/transactions.js';
import type { TransactionPage as TargetPage } from '../../target/transactions.js';
import { parseTransactionsHtml } from './parse.js';

const ACCOUNT = DEMO_ACCOUNTS[0]!;
const SMALL = DEMO_ACCOUNTS[1]!;

function pageBytes(accountNo: string, count: number, page: number): Buffer {
  return encodeEucKr(renderTransactionsHtml(selectPage(accountNo, count, page)));
}

function parseOk(body: Buffer) {
  const result = parseTransactionsHtml(body);
  if (!result.ok) throw new Error(`파싱 실패: ${result.detail}`);
  return result.page;
}

describe('거래내역 파서', () => {
  it('137건 전 페이지를 읽으면 원장과 전 필드가 일치한다', () => {
    // 한 페이지만 보면 마지막 페이지의 짧은 행 수나 잔액 누적이 틀려도 못 잡는다.
    const ledger = buildLedger(ACCOUNT.accountNo, ACCOUNT.txCount);
    const collected = [];
    const totalPages = Math.ceil(ACCOUNT.txCount / 20);
    for (let page = 1; page <= totalPages; page += 1) {
      const parsed = parseOk(pageBytes(ACCOUNT.accountNo, ACCOUNT.txCount, page));
      expect(parsed).toMatchObject({
        accountNo: ACCOUNT.accountNo,
        page,
        pageSize: 20,
        total: ACCOUNT.txCount,
        totalPages,
      });
      collected.push(...parsed.rows);
    }
    expect(collected).toHaveLength(137);
    expect(collected).toEqual(ledger);
  });

  it('한 페이지에 다 들어가는 계좌도 읽는다', () => {
    const parsed = parseOk(pageBytes(SMALL.accountNo, SMALL.txCount, 1));
    expect(parsed.rows).toEqual(buildLedger(SMALL.accountNo, SMALL.txCount));
    expect(parsed.totalPages).toBe(1);
  });

  it('마지막 페이지 이후는 행 0개의 정상 페이지다', () => {
    const parsed = parseOk(pageBytes(ACCOUNT.accountNo, ACCOUNT.txCount, 8));
    expect(parsed.rows).toEqual([]);
    expect(parsed.total).toBe(137);
    expect(parsed.page).toBe(8);
  });

  it('0건 계좌의 1페이지도 정상이다', () => {
    const parsed = parseOk(pageBytes('000-00-000000', 0, 1));
    expect(parsed.rows).toEqual([]);
    expect(parsed.totalPages).toBe(1);
  });

  it('escapeHtml을 되돌리고, 0원 빈 칸과 음수 잔액을 읽는다', () => {
    // 렌더러는 대상 서버 것을 그대로 쓰고 데이터만 경계값으로 만든다.
    const page: TargetPage = {
      accountNo: '000-&-"<>"',
      page: 1,
      pageSize: 20,
      total: 2,
      totalPages: 1,
      rows: [
        { seq: 1, at: '2026-01-02 00:00:00', memo: 'A&B <x> "q" &amp;', withdrawal: 1000, deposit: 0, balance: 0 },
        { seq: 2, at: '2026-01-02 06:00:00', memo: '마이너스', withdrawal: 1000, deposit: 0, balance: -1000 },
      ],
    };
    const parsed = parseOk(encodeEucKr(renderTransactionsHtml(page)));
    expect(parsed.accountNo).toBe('000-&-"<>"');
    expect(parsed.rows).toEqual(page.rows);
  });

  it('UTF-8 바이트를 EUC-KR로 읽게 되면 성공으로 올리지 않는다', () => {
    // 숫자는 멀쩡히 읽히고 한글만 깨지는 경로다. 조용히 틀리면 안 된다.
    const html = renderTransactionsHtml(selectPage(ACCOUNT.accountNo, ACCOUNT.txCount, 1));
    const result = parseTransactionsHtml(Buffer.from(html, 'utf8'));
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('디코딩') });
  });

  it('행 하나가 빠지면 요약과 모순이라 실패다', () => {
    const html = renderTransactionsHtml(selectPage(ACCOUNT.accountNo, ACCOUNT.txCount, 1));
    const dropped = html.replace(/\s*<tr data-seq="5">[\s\S]*?<\/tr>/, '');
    expect(dropped).not.toBe(html);
    const result = parseTransactionsHtml(encodeEucKr(dropped));
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('행 수') });
  });

  it('행 수가 페이지 크기를 넘으면 실패다', () => {
    const selected = selectPage(ACCOUNT.accountNo, ACCOUNT.txCount, 1);
    const html = renderTransactionsHtml({ ...selected, rows: buildLedger(ACCOUNT.accountNo, ACCOUNT.txCount).slice(0, 21) });
    expect(parseTransactionsHtml(encodeEucKr(html)).ok).toBe(false);
  });

  it('data-seq 없는 행이 섞이면 건너뛰지 않고 실패한다', () => {
    const html = renderTransactionsHtml(selectPage(ACCOUNT.accountNo, ACCOUNT.txCount, 1)).replace(
      '<tr data-seq="3">',
      '<tr class="row">',
    );
    const result = parseTransactionsHtml(encodeEucKr(html));
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('tr') });
  });

  it('원화 기호가 ?로 깨진 금액은 받지 않는다', () => {
    // U+20A9를 EUC-KR로 인코딩하면 iconv-lite가 예외 없이 0x3F로 바꾼다.
    const html = renderTransactionsHtml(selectPage(ACCOUNT.accountNo, ACCOUNT.txCount, 1)).replaceAll('￦', '₩');
    const bytes = encodeEucKr(html);
    expect(bytes.includes(Buffer.from('?1', 'latin1'))).toBe(true);
    expect(parseTransactionsHtml(bytes)).toMatchObject({ ok: false, detail: expect.stringContaining('금액') });
  });

  it('요약의 totalPages가 total과 맞지 않으면 실패다', () => {
    const html = renderTransactionsHtml(selectPage(ACCOUNT.accountNo, ACCOUNT.txCount, 1)).replace(
      'data-total-pages="7"',
      'data-total-pages="6"',
    );
    expect(parseTransactionsHtml(encodeEucKr(html))).toMatchObject({ ok: false, detail: expect.stringContaining('totalPages') });
  });
});
