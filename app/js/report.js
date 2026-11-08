// Подготовка отчёта для ИИ-трихолога (Claude) и разбор его ответа.
import {
  ymd, addDays, at, parseYmd, computeStats, currentStreak, instancesFor, statusOf, versionFor, describeSchedule, daysBetween, RATING_LABELS,
} from './schedule.js';
import { PHOTO_ZONES, STYLES } from './photo-guide.js';
import { monthsSince, stageFor, zoneExpectation } from './transplant.js';
import { ZONE_BY_ID } from './zones-data.js';

export const ZONES = PHOTO_ZONES;

export const KINDS = { oral: 'внутрь', topical: 'наружно', procedure: 'процедура' };

export const SCORE_LABELS = {
  overall: 'Общая',
  density: 'Густота',
  crown: 'Макушка',
  hairline: 'Линия роста',
};

const pct = (x) => (x == null ? '—' : Math.round(x * 100) + '%');

function transplantLines(tp, now) {
  if (!tp?.date) return [];
  const m = monthsSince(tp.date, now);
  const st = stageFor(m);
  const names = (ids) => ids.map((id) => ZONE_BY_ID[id]?.name || id).join(', ') || 'не указаны';
  const lines = ['', 'Пересадка волос:'];
  lines.push(`- Дата: ${tp.date}, прошло ${m.toFixed(1)} мес. (этап «${st.name}»)`);
  lines.push(`- Графтов: ${tp.grafts || '?'}, метод: ${tp.method || '?'}`);
  lines.push(`- Зоны пересадки: ${names(tp.zones || [])}`);
  lines.push(`- Донорские зоны: ${names(tp.donor || [])}`);
  for (const id of tp.zones || []) {
    const e = zoneExpectation(id, m);
    lines.push(`  · ${ZONE_BY_ID[id]?.name}: эффективный срок ${e.effMonths.toFixed(1)} мес., ожидаемо ${e.pct || 'рост ещё не начался'}`);
  }
  const cuts = [...(tp.haircuts || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (cuts.length) lines.push(`- Стрижки после пересадки: ${cuts.map((c) => `${c.date}${c.note ? ' (' + c.note + ')' : ''}`).join('; ')}`);
  else lines.push('- Волосы в зоне пересадки НЕ стриглись с момента операции (длинные, неравной длины).');
  return lines;
}

export function buildReport({ items, logs, photos, allPhotos = photos, analyses, transplant, now = new Date() }) {
  const today = ymd(now);
  const from = addDays(today, -29);
  const st = computeStats(items, logs, from, today, now);
  const t = st.total;
  const lines = [];

  lines.push('Отчёт приложения «Рост волос» — проанализируй по навыку hair-trichologist.');
  lines.push(`Дата: ${today}`);
  const starts = items.map((i) => i.startDate).sort();
  if (starts.length) lines.push(`Уход начат: ${starts[0]} (${daysBetween(starts[0], today)} дн. назад)`);

  lines.push(...transplantLines(transplant, now));

  lines.push('', `Фото во вложении (${photos.length}), по порядку. Снято в ванной при верхнем свете, на сухих волосах:`);
  photos.forEach((p, i) => {
    const style = p.style ? `; укладка: ${STYLES[p.style] || p.style}` : '';
    lines.push(`${i + 1}. ${p.date} — ${ZONES[p.zone] || p.zone}${style}${p.note ? '; ' + p.note : ''}`);
  });

  lines.push('', '=== СХЕМА УХОДА (всё, что пью, наношу и делаю) ===');
  if (!items.length) lines.push('Схема не заполнена.');
  for (const it of items) lines.push(...itemBlock(it, logs, today, now));

  lines.push('', '=== СОБЛЮДЕНИЕ СХЕМЫ: ОБЩАЯ КАРТИНА ===');
  if (t.planned) {
    lines.push(`За 30 дней: рейтинг ${t.rating}/5 (${RATING_LABELS[t.rating]}), выполнение ${pct(t.score)}. Запланировано ${t.planned}: вовремя ${t.ontime}, с опозданием ${t.late}, пропущено осознанно ${t.skipped}, не отмечено ${t.missed}.`);
  } else {
    lines.push('За 30 дней данных нет.');
  }
  for (const days of [7, 90]) {
    const s = computeStats(items, logs, addDays(today, -(days - 1)), today, now).total;
    if (s.planned) lines.push(`За ${days} дней: ${pct(s.score)} (рейтинг ${s.rating}/5), приёмов ${s.planned}.`);
  }
  lines.push(`Дней подряд без пропусков: ${currentStreak(items, logs, now)}.`);
  lines.push(...weekdayLines(items, logs, addDays(today, -89), today, now, 'Пропуски по дням недели (90 дней)'));
  lines.push(...monthlyLines(items, logs, analyses, today, now));

  const sorted = [...analyses].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length) {
    lines.push('', '=== МОИ ПРОШЛЫЕ ЗАКЛЮЧЕНИЯ ===');
    for (const a of sorted.slice(-8)) {
      const sc = a.scores ? Object.entries(a.scores).map(([k, v]) => `${k}=${v}`).join(' ') : 'без оценок';
      lines.push(`- ${a.date}: ${sc}`);
    }
    const last = sorted[sorted.length - 1];
    const body = last.text.replace(/HAIRLOG[^\n]*/i, '').trim();
    lines.push(`Последнее заключение (${last.date}), кратко:`, body.length > 900 ? body.slice(0, 900) + '…' : body);
  }

  const byZone = {};
  for (const p of allPhotos) (byZone[p.zone] ||= []).push(p.date);
  if (allPhotos.length) {
    lines.push('', '=== ИСТОРИЯ ФОТО ===');
    for (const [z, ds] of Object.entries(byZone)) {
      ds.sort();
      lines.push(`- ${ZONES[z] || z}: ${ds.length} фото, с ${ds[0]} по ${ds[ds.length - 1]}`);
    }
  }

  lines.push('', 'Проанализируй всё: фото по зонам, срок после пересадки, каждый препарат и процедуру (что, сколько, когда, насколько регулярно и вовремя), закономерности пропусков и связь соблюдения схемы с динамикой. Сравни с прошлыми оценками и в самом конце дай строку HAIRLOG.');
  return lines.join('\n');
}

const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

// Подробности по одному препарату/процедуре: схема, история изменений, соблюдение, время приёма, пропуски.
function itemBlock(it, logs, today, now) {
  const active = !it.endDate || it.endDate >= today;
  const v = versionFor(it, today);
  const out = ['', `■ ${it.name} — ${KINDS[it.kind] || it.kind}${active ? '' : ' (курс завершён)'}`];
  out.push(`  Сейчас: ${v.dose || 'доза не указана'}; время ${v.times.join(', ')}; ${describeSchedule(v)}.`);
  out.push(`  Курс: с ${it.startDate}${it.endDate ? ' по ' + it.endDate : ''} (${daysBetween(it.startDate, it.endDate && it.endDate < today ? it.endDate : today)} дн.)${it.notes ? '; заметка: ' + it.notes : ''}.`);
  const r = it.remind;
  out.push(`  Напоминание: ${r && r.before === null ? 'выключено' : `за ${r?.before || 0} мин${r?.again ? `, повтор через ${r.again} мин` : ''}`}.`);
  if (it.versions.length > 1) {
    out.push('  История изменений схемы:');
    for (const ver of it.versions) out.push(`   · с ${ver.from}: ${ver.dose || '—'}; ${ver.times.join(', ')}; ${describeSchedule(ver)}`);
  }

  const end = it.endDate && it.endDate < today ? it.endDate : today;
  const windows = [[7, ' 7 дн'], [30, '30 дн'], [90, '90 дн']];
  const parts = [];
  for (const [d, l] of windows) {
    const from = addDays(end, -(d - 1));
    const s = computeStats([it], logs, from < it.startDate ? it.startDate : from, end, now).total;
    if (s.planned) parts.push(`${l}: сделано ${s.ontime + s.late} из ${s.planned}, балл ${pct(s.score)}`);
  }
  const all = computeStats([it], logs, it.startDate, end, now).total;
  if (all.planned) parts.push(`весь курс: сделано ${all.ontime + all.late} из ${all.planned}, балл ${pct(all.score)}, рейтинг ${all.rating}/5`);
  out.push(`  Выполнение (балл: вовремя = 1, с опозданием = 0,75) — ${parts.join('; ') || 'данных пока нет'}.`);
  if (all.planned) out.push(`  За весь курс: вовремя ${all.ontime}, с опозданием ${all.late}, пропущено осознанно ${all.skipped}, не отмечено ${all.missed}.`);

  // Точность времени приёма (последние 90 дней)
  const from90 = addDays(end, -89);
  const perSlot = {};
  const devs = [];
  const misses = [];
  for (let d = from90 < it.startDate ? it.startDate : from90; d <= end; d = addDays(d, 1)) {
    for (const inst of instancesFor([it], d)) {
      const log = logs.get(inst.key);
      const stt = statusOf(inst, log, now);
      if (stt === 'upcoming' || stt === 'due') continue;
      const slot = (perSlot[inst.time] ||= { n: 0, ok: 0 });
      slot.n++;
      if (stt === 'ontime' || stt === 'late') {
        slot.ok++;
        devs.push((new Date(log.at) - at(inst.date, inst.time)) / 60000);
      } else if (d >= addDays(end, -13)) {
        misses.push(`${d.slice(5)} ${WD[parseYmd(d).getDay()]} ${inst.time} (${stt === 'skipped' ? 'пропуск' : 'не отмечено'})`);
      }
    }
  }
  if (devs.length) {
    const abs = devs.map(Math.abs).sort((a, b) => a - b);
    const median = abs[Math.floor(abs.length / 2)];
    const avg = devs.reduce((a, b) => a + b, 0) / devs.length;
    out.push(`  Точность времени (90 дн): медианное отклонение ${Math.round(median)} мин, в среднем ${avg >= 0 ? 'позже' : 'раньше'} плана на ${Math.abs(Math.round(avg))} мин; позже чем на 1 час — ${Math.round((devs.filter((x) => x > 60).length / devs.length) * 100)}% приёмов.`);
  }
  const slots = Object.entries(perSlot);
  if (slots.length > 1) out.push(`  По времени суток: ${slots.map(([tm, s]) => `${tm} — ${pct(s.ok / s.n)}`).join(', ')}.`);
  out.push(...weekdayLines([it], logs, from90 < it.startDate ? it.startDate : from90, end, now, '  Пропуски по дням недели'));
  if (misses.length) out.push(`  Пропуски за последние 14 дней: ${misses.slice(-10).join(', ')}.`);
  return out;
}

function weekdayLines(items, logs, from, to, now, title) {
  const miss = Array(7).fill(0);
  const plan = Array(7).fill(0);
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = parseYmd(d).getDay();
    for (const inst of instancesFor(items, d)) {
      const s = statusOf(inst, logs.get(inst.key), now);
      if (s === 'upcoming' || s === 'due') continue;
      plan[wd]++;
      if (s === 'skipped' || s === 'missed') miss[wd]++;
    }
  }
  const total = miss.reduce((a, b) => a + b, 0);
  if (!total) return plan.some(Boolean) ? [`${title}: пропусков нет.`] : [];
  const order = [1, 2, 3, 4, 5, 6, 0].filter((i) => plan[i]);
  return [`${title}: ${order.map((i) => `${WD[i]} ${miss[i]}/${plan[i]}`).join(', ')}.`];
}

// Помесячное соблюдение рядом с оценками ИИ — чтобы видеть связь режима и результата.
function monthlyLines(items, logs, analyses, today, now) {
  if (!items.length) return [];
  const first = items.map((i) => i.startDate).sort()[0];
  const out = ['Соблюдение по месяцам (и оценка ИИ в этом месяце):'];
  let m = first.slice(0, 7);
  const end = today.slice(0, 7);
  while (m <= end) {
    const from = `${m}-01` < first ? first : `${m}-01`;
    const [y, mo] = m.split('-').map(Number);
    const last = ymd(new Date(y, mo, 0));
    const s = computeStats(items, logs, from, last < today ? last : today, now).total;
    const ai = analyses.filter((a) => a.date.startsWith(m) && a.scores).map((a) => `overall=${a.scores.overall ?? '?'}`).join(', ');
    out.push(`- ${m}: ${s.planned ? `${pct(s.score)} (рейтинг ${s.rating}/5)` : 'нет данных'}${ai ? `; ИИ: ${ai}` : ''}`);
    m = ymd(new Date(y, mo, 1)).slice(0, 7);
  }
  return out;
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
