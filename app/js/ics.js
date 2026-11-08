// Генерация .ics с повторяющимися событиями и будильниками для Календаря iPhone.
// Так напоминания работают системно, даже когда приложение закрыто, и без сервера.
import { ymd, addDays, isScheduled, versionFor } from './schedule.js';

const KIND_EMOJI = { oral: '💊', topical: '🧴', procedure: '✨' };
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function escapeText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Перенос строк по 75 байт UTF-8 (RFC 5545).
function fold(line) {
  const enc = new TextEncoder();
  const parts = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

const compact = (date) => date.replace(/-/g, '');

export function buildIcs(items, appUrl, now = new Date()) {
  const today = ymd(now);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HairGrowth//RU', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Рост волос'];
  let count = 0;

  for (const item of items) {
    if (item.endDate && item.endDate < today) continue;
    const before = item.remind ? item.remind.before : 0; // null — напоминания выключены
    if (before === null) continue;
    const again = item.remind?.again || 0;
    // Первая дата, когда приём действительно запланирован (важно для режима «раз в N дней»).
    let first = item.startDate > today ? item.startDate : today;
    let guard = 0;
    while (!isScheduled(item, first) && guard++ < 400) first = addDays(first, 1);
    if (guard >= 400) continue;
    const v = versionFor(item, first);

    let rule;
    if (v.mode === 'weekdays') rule = `FREQ=WEEKLY;BYDAY=${v.weekdays.map((d) => BYDAY[d]).join(',')}`;
    else if (v.mode === 'interval' && v.interval > 1) rule = `FREQ=DAILY;INTERVAL=${v.interval}`;
    else rule = 'FREQ=DAILY';
    if (item.endDate) rule += `;UNTIL=${compact(item.endDate)}T235959`;

    const title = `${KIND_EMOJI[item.kind] || '💊'} ${item.name}${v.dose ? ' — ' + v.dose : ''}`;
    const desc = [item.notes, 'Отметьте приём в приложении «Рост волос».'].filter(Boolean).join('\n');

    for (const time of v.times) {
      count++;
      lines.push(
        'BEGIN:VEVENT',
        `UID:hg-${item.id}-${time.replace(':', '')}@hairgrowth`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${compact(first)}T${time.replace(':', '')}00`,
        'DURATION:PT10M',
        `RRULE:${rule}`,
        `SUMMARY:${escapeText(title)}`,
        `DESCRIPTION:${escapeText(desc)}`,
        appUrl ? `URL:${appUrl}` : null,
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        before ? `TRIGGER:-PT${before}M` : 'TRIGGER:PT0S',
        `DESCRIPTION:${escapeText(before ? `${title} — через ${before} мин` : title)}`,
        'END:VALARM',
        ...(again ? [
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          `TRIGGER:PT${again}M`,
          `DESCRIPTION:${escapeText(`Не забыли? ${title}`)}`,
          'END:VALARM',
        ] : []),
        'END:VEVENT',
      );
    }
  }
  lines.push('END:VCALENDAR');
  return { text: lines.filter(Boolean).map(fold).join('\r\n') + '\r\n', count };
}
