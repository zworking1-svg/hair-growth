// Расписание приёма и аналитика соблюдения. Чистые функции без DOM.

// Отметка в пределах ±60 минут от запланированного времени считается «вовремя».
export const ON_TIME_MIN = 60;

// Баллы за каждый запланированный приём.
export const POINTS = { ontime: 1, late: 0.75, skipped: 0, missed: 0 };

export const RATING_LABELS = { 1: 'Плохо', 2: 'Слабо', 3: 'Средне', 4: 'Хорошо', 5: 'Супер' };

const pad = (n) => String(n).padStart(2, '0');

export function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function daysBetween(a, b) {
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
}

export function at(date, time) {
  const d = parseYmd(date);
  const [h, m] = time.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

export function logKey(itemId, date, time) {
  return `${itemId}|${date}|${time}`;
}

// Версия схемы, действующая на дату (схема могла меняться со временем — история не ломается).
export function versionFor(item, date) {
  let v = item.versions[0];
  for (const s of item.versions) if (s.from <= date) v = s;
  return v;
}

export function isScheduled(item, date) {
  if (date < item.startDate) return false;
  if (item.endDate && date > item.endDate) return false;
  const v = versionFor(item, date);
  if (v.mode === 'weekdays') return v.weekdays.includes(parseYmd(date).getDay());
  if (v.mode === 'interval') return daysBetween(item.startDate, date) % Math.max(1, v.interval) === 0;
  return true;
}

export function instancesFor(items, date) {
  const out = [];
  for (const item of items) {
    if (!isScheduled(item, date)) continue;
    const v = versionFor(item, date);
    for (const time of v.times) {
      out.push({ key: logKey(item.id, date, time), item, dose: v.dose, date, time });
    }
  }
  return out.sort((a, b) => a.time.localeCompare(b.time) || a.item.name.localeCompare(b.item.name));
}

// ontime | late | skipped — если есть отметка; upcoming | due | missed — если нет.
export function statusOf(inst, log, now = new Date()) {
  const planned = at(inst.date, inst.time);
  if (log) {
    if (log.status === 'skipped') return 'skipped';
    const diff = Math.abs(new Date(log.at) - planned) / 60000;
    return diff <= ON_TIME_MIN ? 'ontime' : 'late';
  }
  const mins = (now - planned) / 60000;
  if (mins < 0) return 'upcoming';
  if (mins <= ON_TIME_MIN && inst.date === ymd(now)) return 'due';
  return 'missed';
}

export function ratingFor(score) {
  if (score == null) return null;
  if (score >= 0.95) return 5;
  if (score >= 0.85) return 4;
  if (score >= 0.7) return 3;
  if (score >= 0.5) return 2;
  return 1;
}

function emptyBucket() {
  return { planned: 0, ontime: 0, late: 0, skipped: 0, missed: 0, pending: 0, points: 0 };
}

function finish(b) {
  b.score = b.planned ? b.points / b.planned : null;
  b.rating = ratingFor(b.score);
  return b;
}

// Статистика за период [from, to] включительно.
export function computeStats(items, logs, from, to, now = new Date()) {
  const total = emptyBucket();
  const perItem = new Map();
  const perDay = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const day = emptyBucket();
    day.date = d;
    for (const inst of instancesFor(items, d)) {
      const st = statusOf(inst, logs.get(inst.key), now);
      if (!perItem.has(inst.item.id)) perItem.set(inst.item.id, Object.assign(emptyBucket(), { item: inst.item }));
      for (const b of [total, day, perItem.get(inst.item.id)]) {
        if (st === 'upcoming' || st === 'due') { b.pending++; continue; }
        b.planned++;
        b[st]++;
        b.points += POINTS[st];
      }
    }
    perDay.push(finish(day));
  }
  finish(total);
  return {
    total,
    perDay,
    perItem: [...perItem.values()].map(finish).sort((a, b) => (a.score ?? 2) - (b.score ?? 2)),
  };
}

// Сколько дней подряд (до сегодня) все приёмы были выполнены.
export function currentStreak(items, logs, now = new Date()) {
  const today = ymd(now);
  let streak = 0;
  let d = today;
  for (let i = 0; i < 3650; i++) {
    const insts = instancesFor(items, d);
    const sts = insts.map((x) => statusOf(x, logs.get(x.key), now));
    const done = sts.filter((s) => s === 'ontime' || s === 'late').length;
    const open = sts.filter((s) => s === 'upcoming' || s === 'due').length;
    if (d === today && open) { d = addDays(d, -1); continue; } // сегодняшний день ещё идёт
    if (!insts.length) {
      if (!items.some((it) => it.startDate <= d)) break;
      d = addDays(d, -1);
      continue;
    }
    if (done !== insts.length) break;
    streak++;
    d = addDays(d, -1);
  }
  return streak;
}

export function describeSchedule(v) {
  const names = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  if (v.mode === 'weekdays') {
    const order = [1, 2, 3, 4, 5, 6, 0];
    return order.filter((d) => v.weekdays.includes(d)).map((d) => names[d]).join(', ');
  }
  if (v.mode === 'interval') return v.interval === 1 ? 'каждый день' : `раз в ${v.interval} дн.`;
  return 'каждый день';
}
