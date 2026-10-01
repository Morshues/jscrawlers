/**
 * What the booker tells the person who will pay. These go out on the booker's
 * own channels and never back to the watcher: the payment link is the one
 * thing that must not pass through it.
 */

function formatPrice(value) {
  return value == null ? '價格不明' : `¥${value.toLocaleString('zh-TW')}`;
}

/**
 * @param {{ roomCode: string, roomName?: string, salesDate: string, planCode: string, memberPrice: number }} cell
 * @param {{ ok: boolean, submitted: boolean, nextUrl?: string|null, payload?: object, error?: string }} result
 * @param {{ submit: boolean }} options false = this was a dry run
 */
export function buildBookingPayload(cell, result, { submit }) {
  const total = result.payload?.reservationGroup?.payment?.amount ?? cell.memberPrice;
  const what = `${cell.salesDate}  ${cell.roomName ?? cell.roomCode}`;
  const lines = [`• ${what}  ${formatPrice(total)}`, `  方案 ${cell.planCode}`, ''];

  let title;
  if (!result.ok) {
    title = `❌ 自動訂房失敗：${what}`;
    lines.push(`原因：${result.error}`);
  } else if (!submit) {
    title = `🧪 自動訂房演練（未送出）：${what}`;
    lines.push('登入與訂房資料都已就緒；BOOKER_SUBMIT=true 才會真的送出。');
  } else {
    title = `✅ 已送出訂房，請立即付款：${what}`;
    lines.push(
      `付款：${result.nextUrl}`,
      '',
      '付款完成後在訂房機上執行 --reset 才會再接受新的訂房。',
    );
  }

  return {
    source: 'd-reserve-booker',
    event: !result.ok ? 'booking-failed' : submit ? 'booking' : 'booking-dry-run',
    title,
    text: lines.join('\n'),
    detectedAt: new Date().toISOString(),
  };
}
