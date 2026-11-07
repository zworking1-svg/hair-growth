// Подготовка отчёта для ИИ-трихолога (Claude) и разбор его ответа.
import { ymd, addDays, computeStats, versionFor, describeSchedule, daysBetween, RATING_LABELS } from './schedule.js';

export const ZONES = {
  crown: 'Макушка',
  hairline: 'Линия роста (лоб)',
  part: 'Пробор',
  temples: 'Виски',
  back: 'Затылок',
  other: 'Другое',
};

export const KINDS = { oral: 'внутрь', topical: 'наружно', procedure: 'процедура' };

export const SCORE_LABELS = {
  overall: 'Общая',
  density: 'Густота',
  crown: 'Макушка',
  hairline: 'Линия роста',
};

const pct = (x) => (x == null ? '—' : Math.round(x * 100) + '%');

export function buildReport({ items, logs, photos, analyses, now = new Date() }) {
  const today = ymd(now);
  const from = addDays(today, -29);
  const st = computeStats(items, logs, from, today, now);
  const t = st.total;
  const lines = [];

  lines.push('Отчёт приложения «Рост волос» — проанализируй по навыку hair-trichologist.');
  lines.push(`Дата: ${today}`);
  const starts = items.map((i) => i.startDate).sort();
  if (starts.length) lines.push(`Уход начат: ${starts[0]} (${daysBetween(starts[0], today)} дн. назад)`);

  lines.push('', `Фото во вложении (${photos.length}), по порядку:`);
  photos.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.date} — ${ZONES[p.zone] || p.zone}${p.note ? ' (' + p.note + ')' : ''}`);
  });

  lines.push('', 'Текущая схема:');
  for (const it of items) {
    if (it.endDate && it.endDate < today) continue;
    const v = versionFor(it, today);
    lines.push(`- ${it.name} (${KINDS[it.kind] || it.kind}): ${v.dose || 'доза не указана'}; ${v.times.join(', ')}; ${describeSchedule(v)}; с ${it.startDate}${it.notes ? '; ' + it.notes : ''}`);
  }
  const ended = items.filter((it) => it.endDate && it.endDate < today);
  if (ended.length) lines.push('Завершённые курсы: ' + ended.map((it) => `${it.name} (${it.startDate} — ${it.endDate})`).join('; '));

  lines.push('', 'Соблюдение схемы за 30 дней:');
  if (t.planned) {
    lines.push(`Рейтинг ${t.rating}/5 (${RATING_LABELS[t.rating]}), выполнение ${pct(t.score)}. Запланировано ${t.planned}: вовремя ${t.ontime}, с опозданием ${t.late}, пропущено ${t.skipped}, не отмечено ${t.missed}.`);
    for (const p of st.perItem) if (p.planned) lines.push(`- ${p.item.name}: ${p.ontime + p.late}/${p.planned} (${pct(p.score)})`);
  } else {
    lines.push('Данных пока нет.');
  }

  const prev = [...analyses].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4);
  if (prev.length) {
    lines.push('', 'Мои прошлые заключения (последние):');
    for (const a of prev) {
      const sc = a.scores ? Object.entries(a.scores).map(([k, v]) => `${k}=${v}`).join(' ') : 'без оценок';
      lines.push(`- ${a.date}: ${sc}`);
    }
  }

  lines.push('', 'Сравни с прошлыми оценками, учти соблюдение схемы и в самом конце дай строку HAIRLOG.');
  return lines.join('\n');
}

// Ищет строку вида «HAIRLOG overall=6 density=6 crown=5 hairline=7 trend=up».
export function parseHairlog(text) {
  const m = String(text).match(/HAIRLOG[:\s]+([^\n]+)/i);
  if (!m) return null;
  const out = {};
  for (const [, k, v] of m[1].matchAll(/([a-z_]+)\s*=\s*([\w.+-]+)/gi)) {
    out[k.toLowerCase()] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return Object.keys(out).length ? out : null;
}
