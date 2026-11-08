import { db, STORES } from './db.js';
import * as S from './schedule.js';
import { buildIcs } from './ics.js';
import { buildReport, parseHairlog, ZONES, KINDS, SCORE_LABELS } from './report.js';
import { prepareImage, blobToDataUrl, dataUrlToBlob } from './images.js';
import { ZONE_LIST, ZONE_BY_ID, COMMON_RATE } from './zones-data.js';
import { PHOTO_GUIDE, STYLES, GENERAL_RULES, LONG_HAIR_NOTES } from './photo-guide.js';
import { DEFAULT_TRANSPLANT, STAGES, TRANSPLANT_FACTS, monthsSince, stageFor, zoneExpectation } from './transplant.js';

// ---------- утилиты ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const today = () => S.ymd(new Date());
const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const pct = (x) => (x == null ? '—' : Math.round(x * 100) + '%');
const KIND_ICON = { oral: '💊', topical: '🧴', procedure: '✨' };
const APP_VERSION = '1.4 · 8 ноября 2026';

function fmtDay(date, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
  return S.parseYmd(date).toLocaleDateString('ru-RU', opts);
}

function stars(r) {
  if (!r) return '<span class="muted">нет данных</span>';
  return `<span class="stars r${r}">${'★'.repeat(r)}<span class="off">${'★'.repeat(5 - r)}</span></span>`;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function openSheet(html) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').classList.add('open');
  $('#sheet-body').scrollTop = 0;
}
function closeSheet() {
  $('#sheet').classList.remove('open');
}

async function shareOrDownload(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

// Кэш ссылок на изображения из базы.
const urlCache = new Map();
function photoUrl(p, kind = 'thumb') {
  const k = p.id + kind;
  if (!urlCache.has(k)) urlCache.set(k, URL.createObjectURL(p[kind] || p.blob));
  return urlCache.get(k);
}

// ---------- состояние ----------
const state = {
  tab: 'today',
  day: today(),
  items: [],
  logs: new Map(),
  photos: [],
  analyses: [],
  period: 30,
  zone: 'all',
  aiSel: null,
  pendingPhotos: [],
  zone3d: 'vertex',
  transplant: structuredClone(DEFAULT_TRANSPLANT),
};

async function loadAll() {
  const [items, logs, photos, analyses, meta] = await Promise.all(STORES.map((s) => db.all(s)));
  state.transplant = meta.find((m) => m.key === 'transplant') || structuredClone(DEFAULT_TRANSPLANT);
  state.items = items.sort((a, b) => (a.created || '').localeCompare(b.created || ''));
  state.logs = new Map(logs.map((l) => [l.key, l]));
  state.photos = photos.sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created));
  state.analyses = analyses.sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created));
}

// ---------- отрисовка ----------
const TITLES = { today: 'Сегодня', plan: 'Схема ухода', photos: 'Фото', zones: 'Карта зон', ai: 'ИИ-трихолог', stats: 'Аналитика' };

function render() {
  $('#title').textContent = TITLES[state.tab];
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  const views = { today: viewToday, plan: viewPlan, photos: viewPhotos, zones: viewZones, ai: viewAi, stats: viewStats };
  $('#view').innerHTML = views[state.tab]();
  updateBadge();
  if (state.tab === 'zones') mountZones();
  else zoneScene?.pause();
}

function updateBadge() {
  const now = new Date();
  const due = S.instancesFor(state.items, today()).filter((i) => {
    const st = S.statusOf(i, state.logs.get(i.key), now);
    return st === 'due' || st === 'missed';
  }).length;
  const b = $('#badge-today');
  b.textContent = due;
  b.hidden = !due;
}

// ----- Сегодня -----
function viewToday() {
  const d = state.day;
  const now = new Date();
  const isFuture = d > today();
  const insts = S.instancesFor(state.items, d);
  const rows = insts.map((inst) => ({ inst, log: state.logs.get(inst.key), st: S.statusOf(inst, state.logs.get(inst.key), now) }));
  const done = rows.filter((r) => r.st === 'ontime' || r.st === 'late').length;
  const dayStats = S.computeStats(state.items, state.logs, d, d, now).total;

  let html = `
    <div class="daynav">
      <button class="icon-btn" data-act="day" data-delta="-1" aria-label="Предыдущий день">‹</button>
      <button class="daynav-title" data-act="day" data-delta="0">
        <b>${d === today() ? 'Сегодня' : esc(fmtDay(d, { weekday: 'long' }))}</b>
        <span>${esc(fmtDay(d, { day: 'numeric', month: 'long', year: 'numeric' }))}</span>
      </button>
      <button class="icon-btn" data-act="day" data-delta="1" aria-label="Следующий день">›</button>
    </div>`;

  if (!state.items.length) {
    return html + `<div class="empty"><div class="empty-ico">🌱</div><p>Схема ухода пока пустая.</p>
      <button class="btn primary" data-act="tab" data-tab="plan">Добавить препараты</button></div>`;
  }
  if (!insts.length) return html + '<div class="empty"><div class="empty-ico">☕</div><p>На этот день ничего не запланировано.</p></div>';

  const ratio = done / insts.length;
  html += `
    <div class="card summary">
      <div class="ring" style="--p:${Math.round(ratio * 100)}"><span>${done}/${insts.length}</span></div>
      <div>
        <div class="summary-title">${done === insts.length ? 'Всё выполнено 🎉' : 'Выполнено за день'}</div>
        <div class="muted">Рейтинг дня: ${dayStats.rating ? stars(dayStats.rating) : 'появится после первых отметок'}</div>
      </div>
    </div>`;

  html += '<div class="list">';
  for (const { inst, log, st } of rows) {
    const icon = KIND_ICON[inst.item.kind] || '💊';
    let act;
    if (log) {
      const chip = log.status === 'skipped'
        ? '<span class="chip skip">Пропущено</span>'
        : `<span class="chip ${st === 'ontime' ? 'ok' : 'late'}">✓ ${hm(new Date(log.at))}${st === 'late' ? ' · поздно' : ''}</span>`;
      act = `${chip}<button class="icon-btn small" data-act="undo" data-key="${esc(inst.key)}" aria-label="Отменить отметку">↺</button>`;
    } else if (isFuture) {
      act = '<span class="chip">Позже</span>';
    } else {
      act = `<button class="round-btn skip" data-act="skip" data-key="${esc(inst.key)}" aria-label="Пропустил">✕</button>
             <button class="round-btn take" data-act="take" data-key="${esc(inst.key)}" aria-label="Принял">✓</button>`;
    }
    const label = { due: 'пора!', missed: 'не отмечено', upcoming: '' }[st] || '';
    html += `
      <div class="dose st-${st}">
        <div class="dose-time">${esc(inst.time)}${label ? `<small>${label}</small>` : ''}</div>
        <div class="dose-main">
          <div class="dose-name">${icon} ${esc(inst.item.name)}</div>
          <div class="dose-sub">${esc([inst.dose, inst.item.notes].filter(Boolean).join(' · '))}</div>
        </div>
        <div class="dose-act">${act}</div>
      </div>`;
  }
  html += '</div>';
  return html;
}

function findInst(key) {
  const [, date] = key.split('|');
  return S.instancesFor(state.items, date).find((i) => i.key === key);
}

async function saveLog(inst, status, atDate) {
  const log = { key: inst.key, itemId: inst.item.id, date: inst.date, time: inst.time, status, at: atDate.toISOString() };
  await db.put('logs', log);
  state.logs.set(log.key, log);
  render();
}

function askTakenTime(inst) {
  const isToday = inst.date === today();
  openSheet(`
    <h2>Во сколько приняли?</h2>
    <p class="muted">${esc(inst.item.name)} · по плану в ${esc(inst.time)}, ${esc(fmtDay(inst.date, { day: 'numeric', month: 'long' }))}</p>
    <div class="stack">
      ${isToday ? `<button class="btn primary" data-act="take-at" data-key="${esc(inst.key)}" data-mode="now">Только что (${hm(new Date())})</button>` : ''}
      <button class="btn" data-act="take-at" data-key="${esc(inst.key)}" data-mode="plan">Вовремя, в ${esc(inst.time)}</button>
      <div class="row">
        <input type="time" id="take-time" value="${esc(inst.time)}" />
        <button class="btn" data-act="take-at" data-key="${esc(inst.key)}" data-mode="custom">Указать время</button>
      </div>
    </div>`);
}

// ----- Схема -----
function viewPlan() {
  const t = today();
  const active = state.items.filter((i) => !i.endDate || i.endDate >= t);
  const ended = state.items.filter((i) => i.endDate && i.endDate < t);
  const card = (it) => {
    const v = S.versionFor(it, t);
    return `
      <button class="card item" data-act="edit-item" data-id="${it.id}">
        <div class="item-ico">${KIND_ICON[it.kind] || '💊'}</div>
        <div class="item-main">
          <div class="item-name">${esc(it.name)}</div>
          <div class="muted">${esc(v.dose || 'доза не указана')} · ${esc(KINDS[it.kind])}</div>
          <div class="item-times">${v.times.map((x) => `<span class="chip">${esc(x)}</span>`).join('')} <span class="muted">${esc(S.describeSchedule(v))}</span></div>
          <div class="muted small">${esc(remindLabel(it))}</div>
          ${it.endDate ? `<div class="muted small">до ${esc(fmtDay(it.endDate, { day: 'numeric', month: 'long' }))}</div>` : ''}
        </div>
        <div class="chev">›</div>
      </button>`;
  };
  return `
    <button class="btn primary wide" data-act="new-item">+ Добавить препарат или процедуру</button>
    <div class="list">${active.map(card).join('') || '<div class="empty small"><p>Добавьте всё, что нужно пить, наносить или делать: таблетки, витамины, лосьоны, маски, мезороллер…</p></div>'}</div>
    ${ended.length ? `<h3 class="section">Завершённые курсы</h3><div class="list dim">${ended.map(card).join('')}</div>` : ''}
    <div class="card info">
      <h3>🔔 Напоминания</h3>
      <p>iPhone не даёт веб-приложениям ставить будильники сами, поэтому напоминания добавляются в <b>Календарь iPhone</b> — они сработают, даже если приложение закрыто.</p>
      <button class="btn primary wide" data-act="ics" ${active.length ? '' : 'disabled'}>Добавить напоминания в Календарь</button>
      <button class="btn wide" data-act="ics-share" ${active.length ? '' : 'disabled'}>Поделиться файлом .ics</button>
      <details><summary>Как это работает</summary>
        <p>Откроется окно «Добавить все» — выберите отдельный календарь, например «Волосы». После изменения схемы удалите старые события (проще всего удалить календарь «Волосы» в приложении Календарь) и добавьте напоминания заново.</p>
      </details>
    </div>`;
}

function itemForm(it) {
  const t = today();
  const v = it ? S.versionFor(it, t) : { dose: '', times: ['09:00'], mode: 'daily', weekdays: [1, 3, 5], interval: 2 };
  const kind = it?.kind || 'oral';
  const wd = [[1, 'Пн'], [2, 'Вт'], [3, 'Ср'], [4, 'Чт'], [5, 'Пт'], [6, 'Сб'], [0, 'Вс']];
  openSheet(`
    <h2>${it ? 'Изменить' : 'Новый пункт схемы'}</h2>
    <form id="item-form" data-id="${it?.id || ''}">
      <label>Название<input name="name" required placeholder="Миноксидил 5%" value="${esc(it?.name)}"></label>
      <div class="seg">
        ${Object.entries(KINDS).map(([k, l]) => `<label><input type="radio" name="kind" value="${k}" ${k === kind ? 'checked' : ''}><span>${KIND_ICON[k]} ${l}</span></label>`).join('')}
      </div>
      <label>Количество / дозировка<input name="dose" placeholder="1 мл, 1 капсула 5 мг, 20 мин…" value="${esc(v.dose)}"></label>
      <div class="field">
        <div class="field-label">Время приёма</div>
        <div id="times">${v.times.map((x) => timeRow(x)).join('')}</div>
        <button type="button" class="btn small" data-act="add-time">+ ещё время</button>
      </div>
      <div class="field">
        <div class="field-label">Повтор</div>
        <select name="mode" id="mode">
          <option value="daily" ${v.mode === 'daily' ? 'selected' : ''}>Каждый день</option>
          <option value="weekdays" ${v.mode === 'weekdays' ? 'selected' : ''}>По дням недели</option>
          <option value="interval" ${v.mode === 'interval' ? 'selected' : ''}>Раз в N дней</option>
        </select>
        <div class="weekdays" data-show="weekdays">
          ${wd.map(([n, l]) => `<label><input type="checkbox" name="wd" value="${n}" ${v.weekdays?.includes(n) ? 'checked' : ''}><span>${l}</span></label>`).join('')}
        </div>
        <label data-show="interval">Каждые N дней<input type="number" name="interval" min="2" max="60" value="${esc(v.interval || 2)}"></label>
      </div>
      <div class="field">
        <div class="field-label">🔔 Напоминание</div>
        <div class="row2">
          <label>Когда напомнить<select name="remBefore">${REMIND_BEFORE.map(([val, l]) => `<option value="${val}" ${String(val) === String(remind(it).before) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Второе напоминание<select name="remAgain">${REMIND_AGAIN.map(([val, l]) => `<option value="${val}" ${val === remind(it).again ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
        <p class="muted small">Действует для каждого времени приёма. После изменения снова нажмите «Добавить напоминания в Календарь».</p>
      </div>
      <div class="row2">
        <label>Начало<input type="date" name="startDate" required value="${esc(it?.startDate || t)}"></label>
        <label>Окончание<input type="date" name="endDate" value="${esc(it?.endDate || '')}"></label>
      </div>
      <label>Заметка<input name="notes" placeholder="после еды, на сухую кожу головы…" value="${esc(it?.notes)}"></label>
      <button class="btn primary wide" type="submit">Сохранить</button>
      ${it ? `<div class="row2">
        <button type="button" class="btn" data-act="end-item" data-id="${it.id}">Завершить курс</button>
        <button type="button" class="btn danger" data-act="del-item" data-id="${it.id}">Удалить</button>
      </div>` : ''}
    </form>`);
  syncModeFields();
}

// Когда напоминать относительно времени приёма (минуты до) и повтор (минуты после).
const REMIND_BEFORE = [
  ['off', 'Не напоминать'], [0, 'Ровно во время приёма'], [5, 'За 5 минут'], [10, 'За 10 минут'], [15, 'За 15 минут'],
  [20, 'За 20 минут'], [30, 'За 30 минут'], [45, 'За 45 минут'], [60, 'За 1 час'], [90, 'За 1,5 часа'], [120, 'За 2 часа'],
];
const REMIND_AGAIN = [[0, 'Не нужно'], [10, 'Через 10 минут'], [15, 'Через 15 минут'], [30, 'Через 30 минут'], [60, 'Через 1 час'], [120, 'Через 2 часа']];

function remind(it) {
  const r = it?.remind || { before: 0, again: 0 };
  return { before: r.before === null ? 'off' : r.before ?? 0, again: r.again || 0 };
}

function remindLabel(it) {
  const r = remind(it);
  if (r.before === 'off') return '🔕 без напоминания';
  const first = REMIND_BEFORE.find(([v]) => v === r.before)?.[1].toLowerCase() || '';
  return `🔔 ${first}${r.again ? ` + повтор через ${r.again} мин` : ''}`;
}

function timeRow(v) {
  return `<div class="row time-row"><input type="time" name="time" value="${esc(v)}" required><button type="button" class="icon-btn small" data-act="del-time" aria-label="Убрать">✕</button></div>`;
}

function syncModeFields() {
  const mode = $('#mode')?.value;
  $$('[data-show]').forEach((el) => { el.hidden = el.dataset.show !== mode; });
}

async function submitItem(form) {
  const f = new FormData(form);
  const times = [...new Set(f.getAll('time').filter(Boolean))].sort();
  if (!times.length) return toast('Укажите хотя бы одно время');
  const mode = f.get('mode');
  const weekdays = f.getAll('wd').map(Number);
  if (mode === 'weekdays' && !weekdays.length) return toast('Выберите дни недели');
  const ver = { dose: f.get('dose').trim(), times, mode, weekdays, interval: Math.max(2, Number(f.get('interval')) || 2) };
  const fields = {
    name: f.get('name').trim(),
    kind: f.get('kind'),
    notes: f.get('notes').trim(),
    remind: {
      before: f.get('remBefore') === 'off' ? null : Number(f.get('remBefore')),
      again: Number(f.get('remAgain')) || 0,
    },
    startDate: f.get('startDate'),
    endDate: f.get('endDate') || null,
  };
  if (fields.endDate && fields.endDate < fields.startDate) return toast('Окончание раньше начала');

  const id = form.dataset.id;
  let item;
  if (id) {
    item = state.items.find((i) => i.id === id);
    const cur = item.versions[item.versions.length - 1];
    const { from, ...curBody } = cur;
    if (JSON.stringify(curBody) !== JSON.stringify(ver)) {
      // Изменения действуют с сегодняшнего дня — прошлая статистика считается по старой схеме.
      const t = today();
      if (cur.from >= t || item.startDate >= t) Object.assign(cur, ver);
      else item.versions.push({ from: t, ...ver });
    }
    Object.assign(item, fields);
  } else {
    item = { id: uid(), created: new Date().toISOString(), ...fields, versions: [{ from: fields.startDate, ...ver }] };
    state.items.push(item);
  }
  await db.put('items', item);
  closeSheet();
  toast('Сохранено. Не забудьте обновить напоминания');
  render();
}

// ----- Фото -----
function viewPhotos() {
  const zones = [['all', 'Все'], ...Object.entries(ZONES)];
  const list = state.photos.filter((p) => state.zone === 'all' || p.zone === state.zone);
  const groups = new Map();
  for (const p of list) {
    if (!groups.has(p.date)) groups.set(p.date, []);
    groups.get(p.date).push(p);
  }
  return `
    <div class="row2">
      <label class="btn primary">📷 Снять<input type="file" accept="image/*" capture="environment" hidden data-photo-input></label>
      <label class="btn">🖼 Из галереи<input type="file" accept="image/*" multiple hidden data-photo-input></label>
    </div>
    ${stylingCard()}
    <div class="chips-scroll">${zones.map(([k, l]) => `<button class="chip-btn ${state.zone === k ? 'on' : ''}" data-act="zone" data-zone="${k}">${l}</button>`).join('')}</div>
    ${state.photos.length >= 2 ? '<button class="btn wide" data-act="compare">⇆ Сравнить «до / после»</button>' : ''}
    ${groups.size ? [...groups].map(([date, ps]) => `
      <h3 class="section">${esc(fmtDay(date, { day: 'numeric', month: 'long', year: 'numeric' }))}</h3>
      <div class="grid">${ps.map((p) => `
        <button class="thumb" data-act="photo" data-id="${p.id}">
          <img src="${photoUrl(p)}" alt="" loading="lazy"><span>${esc(ZONES[p.zone])}</span>
        </button>`).join('')}</div>`).join('') : `
      <div class="empty"><div class="empty-ico">📸</div><p>Фото пока нет.</p></div>`}
    ${photoGuideHtml()}`;
}

// Всегда открытая шпаргалка: как уложить волосы перед съёмкой каждой зоны.
function stylingCard() {
  return `
    <div class="card styling">
      <h3>💇 Укладка перед съёмкой</h3>
      <p class="muted small">Волосы сухие, без средств. Для каждой зоны — своя укладка, всегда одинаковая:</p>
      <table>${Object.entries(ZONES).filter(([k]) => k !== 'other').map(([k, l]) => `
        <tr><th>${esc(l)}</th><td>${esc(STYLES[PHOTO_GUIDE[k].style])}</td></tr>`).join('')}
      </table>
      <p class="muted small">Подробно — как держать телефон, угол, свет — в разделе «Как фотографировать в ванной» ниже.</p>
    </div>`;
}

function guideCard(zone) {
  const g = PHOTO_GUIDE[zone];
  if (!g) return '';
  return `<dl class="guide">
    <dt>📱 Камера</dt><dd>${esc(g.camera)}</dd>
    <dt>✋ Как держать</dt><dd>${esc(g.hold)}</dd>
    <dt>🙂 Голова</dt><dd>${esc(g.head)}</dd>
    <dt>💇 Укладка</dt><dd>${esc(g.styling)}</dd>
    <dt>💡 Совет</dt><dd>${esc(g.tips)}</dd>
  </dl>`;
}

function photoGuideHtml() {
  const list = (arr) => `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  return `
    <h3 class="section">Как фотографировать в ванной</h3>
    <details class="card info"><summary>Общие правила (прочитайте один раз)</summary>${list(GENERAL_RULES)}</details>
    <details class="card info"><summary>Длинные волосы и стрижка</summary>${list(LONG_HAIR_NOTES)}</details>
    ${Object.entries(ZONES).filter(([k]) => k !== 'other').map(([k, l]) => `
      <details class="card"><summary>${esc(l)} <span class="muted small">· ${esc(STYLES[PHOTO_GUIDE[k].style])}</span></summary>${guideCard(k)}</details>`).join('')}`;
}

async function onPhotosPicked(files) {
  if (!files.length) return;
  toast('Обработка фото…');
  state.pendingPhotos = [];
  for (const file of files) {
    try {
      const { blob, thumb } = await prepareImage(file);
      const lm = file.lastModified ? S.ymd(new Date(file.lastModified)) : today();
      state.pendingPhotos.push({ blob, thumb, date: lm > today() ? today() : lm });
    } catch (e) {
      toast(e.message);
    }
  }
  if (!state.pendingPhotos.length) return;
  const preview = state.pendingPhotos.map((p) => `<img src="${URL.createObjectURL(p.thumb)}" alt="">`).join('');
  openSheet(`
    <h2>Сохранить фото (${state.pendingPhotos.length})</h2>
    <div class="preview">${preview}</div>
    <form id="photo-form">
      <div class="field"><div class="field-label">Зона</div>
        <div class="seg wrap">${Object.entries(ZONES).map(([k, l], i) => `<label><input type="radio" name="zone" value="${k}" ${i === 0 ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      </div>
      <label>Укладка на снимке<select name="style" id="photo-style">${Object.entries(STYLES).map(([k, l]) => `<option value="${k}" ${k === PHOTO_GUIDE.hairline.style ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <details class="card info small-guide"><summary>Как снимать эту зону</summary><div id="photo-guide">${guideCard('hairline')}</div></details>
      <label>Дата снимка<input type="date" name="date" value="${state.pendingPhotos[0].date}" max="${today()}"></label>
      <label>Заметка<input name="note" placeholder="длина волос ~5 см, 3 дня после мытья…"></label>
      <button class="btn primary wide" type="submit">Сохранить</button>
    </form>`);
}

async function submitPhotos(form) {
  const f = new FormData(form);
  for (const p of state.pendingPhotos) {
    const rec = { id: uid(), created: new Date().toISOString(), date: f.get('date') || p.date, zone: f.get('zone'), style: f.get('style'), note: f.get('note').trim(), blob: p.blob, thumb: p.thumb };
    await db.put('photos', rec);
    state.photos.push(rec);
  }
  state.photos.sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created));
  state.pendingPhotos = [];
  state.aiSel = null;
  closeSheet();
  toast('Фото сохранены');
  render();
}

function showPhoto(id) {
  const p = state.photos.find((x) => x.id === id);
  openSheet(`
    <img class="full" src="${photoUrl(p, 'blob')}" alt="">
    <h2>${esc(ZONES[p.zone])}</h2>
    <p class="muted">${esc(fmtDay(p.date, { day: 'numeric', month: 'long', year: 'numeric' }))}${p.style ? ' · ' + esc(STYLES[p.style]) : ''}${p.note ? ' · ' + esc(p.note) : ''}</p>
    <div class="row2">
      <button class="btn" data-act="compare" data-id="${p.id}">⇆ Сравнить</button>
      <button class="btn danger" data-act="del-photo" data-id="${p.id}">Удалить</button>
    </div>`);
}

function showCompare(id) {
  const base = id ? state.photos.find((x) => x.id === id) : state.photos[0];
  const same = state.photos.filter((p) => p.zone === base.zone);
  const pool = same.length >= 2 ? same : state.photos;
  const after = id ? base : pool[0];
  const before = pool[pool.length - 1] === after ? pool[pool.length - 2] || after : pool[pool.length - 1];
  const opts = (sel) => state.photos.map((p) => `<option value="${p.id}" ${p.id === sel.id ? 'selected' : ''}>${esc(p.date)} · ${esc(ZONES[p.zone])}</option>`).join('');
  openSheet(`
    <h2>До / после</h2>
    <div class="row2">
      <label>До<select id="cmp-a">${opts(before)}</select></label>
      <label>После<select id="cmp-b">${opts(after)}</select></label>
    </div>
    <div class="compare" id="compare">
      <img id="cmp-img-a" src="${photoUrl(before, 'blob')}" alt="">
      <img id="cmp-img-b" src="${photoUrl(after, 'blob')}" alt="" style="clip-path: inset(0 0 0 50%)">
      <div class="cmp-line" style="left:50%"></div>
      <span class="cmp-tag l">до</span><span class="cmp-tag r">после</span>
    </div>
    <input type="range" id="cmp-range" min="0" max="100" value="50" aria-label="Положение шторки">`);
}

// ----- 3D-карта зон -----
// Сцена создаётся один раз (three.js грузится только при первом открытии вкладки)
// и переносится между перерисовками, чтобы не пересоздавать WebGL-контекст.
let zoneStage = null;
let zoneScene = null;
let zoneMounting = null;

function viewZones() {
  return `
    <div id="z3d-slot"></div>
    <div class="chips-scroll">${ZONE_LIST.map((z) => `
      <button class="chip-btn zone-chip ${z.id === state.zone3d ? 'on' : ''}" data-act="z3d-zone" data-id="${z.id}" style="--zc:${z.color}"><i></i>${esc(z.name)}${zoneRole(z.id) ? ` <small>${zoneRole(z.id) === 'tx' ? '✦' : '◇'}</small>` : ''}</button>`).join('')}</div>
    ${transplantCard()}
    <div class="card zone-info" id="zone-info">${zoneInfo(state.zone3d)}</div>
    <details class="card info"><summary>Как быстро растут волосы</summary><p>${esc(COMMON_RATE)}</p></details>`;
}

// 'tx' — зона пересадки, 'donor' — донорская, null — не затронута.
function zoneRole(id) {
  const tp = state.transplant;
  if (tp?.zones?.includes(id)) return 'tx';
  if (tp?.donor?.includes(id)) return 'donor';
  return null;
}

function transplantCard() {
  const tp = state.transplant;
  const m = monthsSince(tp.date);
  const st = stageFor(m);
  const max = 18;
  const marks = STAGES.filter((s) => s.from > 0).map((s) => `<i style="left:${(s.from / max) * 100}%"></i>`).join('');
  const cut = tp.haircuts?.length
    ? `Последняя стрижка: ${esc(fmtDay([...tp.haircuts].sort((a, b) => b.date.localeCompare(a.date))[0].date, { day: 'numeric', month: 'long' }))}`
    : 'С пересадки не стриглись';
  return `
    <div class="card tx">
      <div class="tx-head">
        <div><h3>Моя пересадка</h3>
          <div class="muted small">${esc(fmtDay(tp.date, { day: 'numeric', month: 'long', year: 'numeric' }))} · ${tp.grafts || '?'} графтов · ${esc(tp.method || '')}</div></div>
        <button class="btn small" data-act="tx-edit">Изменить</button>
      </div>
      <div class="tx-month"><b>${m.toFixed(1)}</b> мес. · этап «${esc(st.name)}»${st.pct ? ` · обычно ${st.pct[0]}–${st.pct[1]}% роста во лбу` : ''}</div>
      <div class="tx-bar"><div style="width:${Math.min(100, (m / max) * 100)}%"></div>${marks}</div>
      <div class="tx-scale muted small"><span>0</span><span>6</span><span>12</span><span>18 мес.</span></div>
      <p>${esc(st.text)}</p>
      <div class="muted small">Сейчас нормально:</div>
      <ul>${st.normal.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <p class="muted small">${cut}${tp.zones?.length ? '' : ' · <b>Отметьте зоны пересадки</b> в «Изменить» — тогда для каждой зоны будет свой срок.'}</p>
      <details><summary>Что важно знать после пересадки 5500 графтов</summary>
        <ul>${TRANSPLANT_FACTS.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      </details>
      <details><summary>Все этапы по месяцам</summary>
        ${STAGES.map((s) => `<p class="${s === st ? 'tx-now' : ''}"><b>${s.from}–${s.to} мес. · ${esc(s.name)}.</b> ${esc(s.text)}</p>`).join('')}
      </details>
    </div>`;
}

function transplantForm() {
  const tp = state.transplant;
  const chips = (name, sel) => ZONE_LIST.map((z) => `<label><input type="checkbox" name="${name}" value="${z.id}" ${sel?.includes(z.id) ? 'checked' : ''}><span>${esc(z.name)}</span></label>`).join('');
  const cuts = [...(tp.haircuts || [])].sort((a, b) => b.date.localeCompare(a.date));
  openSheet(`
    <h2>Моя пересадка</h2>
    <form id="tx-form">
      <div class="row2">
        <label>Дата операции<input type="date" name="date" required value="${esc(tp.date)}"></label>
        <label>Графтов<input type="number" name="grafts" min="0" step="50" value="${esc(tp.grafts)}"></label>
      </div>
      <label>Метод<select name="method">${['FUE', 'DHI', 'FUT', 'Другой'].map((x) => `<option ${x === tp.method ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <div class="field"><div class="field-label">Куда пересаживали</div><div class="seg wrap">${chips('zones', tp.zones)}</div></div>
      <div class="field"><div class="field-label">Откуда брали (донор)</div><div class="seg wrap">${chips('donor', tp.donor)}</div></div>
      <button class="btn primary wide" type="submit">Сохранить</button>
    </form>
    <h3 class="section">Стрижки после пересадки</h3>
    <div class="list">${cuts.map((c) => `<div class="dose"><div class="dose-main"><div class="dose-name">${esc(fmtDay(c.date, { day: 'numeric', month: 'long', year: 'numeric' }))}</div><div class="dose-sub">${esc(c.note || '')}</div></div>
      <button class="icon-btn small" data-act="tx-cut-del" data-date="${esc(c.date)}" aria-label="Удалить">✕</button></div>`).join('') || '<p class="muted">Пока не стриглись.</p>'}</div>
    <form id="cut-form">
      <div class="row2">
        <label>Дата<input type="date" name="date" required value="${today()}"></label>
        <label>Что сделали<select name="note">
          <option>Подровнял зону пересадки</option><option>Стрижка всей головы</option><option>Машинка по бокам и донору</option><option>Короткая стрижка</option>
        </select></label>
      </div>
      <button class="btn wide" type="submit">+ Отметить стрижку</button>
    </form>`);
}

async function saveTransplant() {
  await db.put('meta', state.transplant);
  render();
}

function zoneInfo(id) {
  const z = ZONE_BY_ID[id];
  const photos = state.photos.filter((p) => p.zone === z.photoZone).length;
  const ai = z.aiKey && state.analyses.find((a) => typeof a.scores?.[z.aiKey] === 'number');
  const list = (arr) => `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  return `
    <div class="zi-head" style="--zc:${z.color}">
      <span class="zi-dot"></span>
      <div><h2>${esc(z.name)}</h2><div class="muted small">${esc(z.en)} · ${esc(z.norwood)}</div></div>
    </div>
    <p>${esc(z.where)}</p>
    <div class="zi-stats" style="--zc:${z.color}">
      <div><span>Чувствительность к ДГТ</span><div class="meter">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= z.dht ? 'on' : ''}"></i>`).join('')}</div></div>
      <div><span>Через 12 мес. без лечения</span><div class="progress"><div style="width:${Math.round(z.growth.no * 100)}%"></div></div></div>
      <div><span>Через 12 мес. с лечением</span><div class="progress"><div style="width:${Math.round(z.growth.tx * 100)}%"></div></div></div>
    </div>
    <p class="muted small">Полосы — наглядная модель густоты при андрогенетической алопеции, не измерения.</p>
    <h3>Скорость роста</h3><p>${esc(z.rate)}</p>
    <h3>Почему здесь растёт быстрее или медленнее</h3>${list(z.why)}
    <h3>Как ускорить рост в этой зоне</h3>${list(z.boost)}
    ${zoneTxSection(z)}
    <h3>Как фотографировать в ванной</h3>
    <p class="muted small">Укладка: <b>${esc(STYLES[PHOTO_GUIDE[z.photoZone].style])}</b></p>
    ${guideCard(z.photoZone)}
    <h3>Как планируют при пересадке</h3><p>${esc(z.transplant)}</p>
    <div class="zi-mine">
      <div><b>Ваши данные</b><div class="muted small">Фото этой зоны: ${photos}${ai ? ` · оценка ИИ ${ai.scores[z.aiKey]}/10 от ${esc(ai.date)}` : ''}</div></div>
      <button class="btn small" data-act="z3d-photos" data-zone="${z.photoZone}">Фото</button>
    </div>
    <p class="muted small">Лекарства и процедуры — только после консультации с врачом.</p>`;
}

function zoneTxSection(z) {
  const role = zoneRole(z.id);
  const m = monthsSince(state.transplant.date);
  if (role === 'tx') {
    const e = zoneExpectation(z.id, m);
    return `<div class="tx-zone" style="--zc:${z.color}">
      <h3>✦ Ваша зона пересадки · ${m.toFixed(1)} мес.</h3>
      <p><b>Чего ждать сейчас:</b> ${e.pct ? `обычно ${e.pct} волос` : 'рост ещё только начинается'} (этап «${esc(e.stage.name)}»${e.lag ? `, зона отстаёт от лба примерно на ${e.lag} мес.` : ''}).</p>
      <p>${esc(z.afterTx)}</p>
    </div>`;
  }
  if (role === 'donor') {
    return `<div class="tx-zone" style="--zc:${z.color}"><h3>◇ Ваша донорская зона</h3><p>${esc(z.afterTx)}</p></div>`;
  }
  return `<h3>После пересадки</h3><p>${esc(z.afterTx)}</p>`;
}

function stageEl() {
  if (!zoneStage) {
    zoneStage = document.createElement('div');
    zoneStage.className = 'z3d';
    zoneStage.innerHTML = `
      <div class="z3d-label"><span></span></div>
      <div class="z3d-loading">Загрузка 3D…</div>
      <div class="z3d-hud">
        <button data-act="z3d-rotate" aria-label="Автовращение">⟳</button>
        <button data-act="z3d-home" aria-label="Общий вид">⌂</button>
      </div>
      <div class="z3d-grow">
        <div class="z3d-status" id="z3d-status">Симуляция роста волос за 12 месяцев</div>
        <div class="z3d-btns">
          <button data-act="z3d-grow" data-mode="no">▶ Без лечения</button>
          <button data-act="z3d-grow" data-mode="tx">▶ С лечением</button>
          <button data-act="z3d-stop" id="z3d-stop" hidden aria-label="Остановить">✕</button>
        </div>
      </div>`;
  }
  return zoneStage;
}

function syncZoneLabel() {
  const z = ZONE_BY_ID[state.zone3d];
  const lbl = zoneStage?.querySelector('.z3d-label span');
  if (lbl) { lbl.textContent = z.name; lbl.style.setProperty('--zc', z.color); }
}

async function mountZones() {
  $('#z3d-slot')?.replaceWith(stageEl());
  syncZoneLabel();
  if (zoneScene) { zoneScene.start(); zoneScene.resize(); return; }
  if (zoneMounting) return;
  zoneMounting = (async () => {
    try {
      const { createZoneScene } = await import('./zones3d.js');
      zoneScene = createZoneScene(zoneStage, { onSelect: selectZone, onGrowth: showGrowth });
      zoneScene.select(state.zone3d, false);
      zoneStage.querySelector('.z3d-loading').remove();
      if (state.tab !== 'zones') zoneScene.pause();
    } catch (e) {
      zoneStage.querySelector('.z3d-loading').textContent = 'Не удалось запустить 3D: ' + e.message;
    }
  })();
}

function selectZone(id) {
  state.zone3d = id;
  zoneScene?.select(id);
  syncZoneLabel();
  const info = $('#zone-info');
  if (info) info.innerHTML = zoneInfo(id);
  $$('.zone-chip').forEach((b) => {
    b.classList.toggle('on', b.dataset.id === id);
    if (b.dataset.id === id) b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  });
}

function showGrowth(g) {
  const st = $('#z3d-status');
  if (!st) return;
  $('#z3d-stop').hidden = !g;
  if (!g) { st.textContent = 'Симуляция роста волос за 12 месяцев'; return; }
  st.textContent = `${g.mode === 'tx' ? 'С лечением' : 'Без лечения'} · месяц ${g.month} из 12${g.done ? ' — сравните зоны' : ''}`;
}

// ----- ИИ-трихолог -----
function viewAi() {
  if (!state.aiSel) {
    const latest = state.photos[0]?.date;
    state.aiSel = new Set(state.photos.filter((p) => p.date === latest).map((p) => p.id));
  }
  const recent = state.photos.slice(0, 30);
  const withScores = state.analyses.filter((a) => a.scores).slice().reverse();
  return `
    <details class="card info" ${state.analyses.length ? '' : 'open'}>
      <summary>Как подключить Claude (один раз)</summary>
      <ol>
        <li>На claude.ai загрузите навык <b>hair-trichologist</b> (zip из папки проекта) в разделе навыков/Skills настроек.</li>
        <li>В приложении Claude создайте проект «Трихолог». Если навыки недоступны, вставьте текст SKILL.md в инструкции проекта.</li>
        <li>Дальше всё по шагам ниже: фото и отчёт уходят в Claude через «Поделиться», ответ возвращается сюда.</li>
      </ol>
      <p class="muted small">Анализ идёт внутри вашей подписки Claude Pro — без API-ключей и доплат. ИИ не заменяет врача-трихолога.</p>
    </details>

    <div class="card">
      <h3>1. Выберите фото</h3>
      ${recent.length ? `<div class="grid sel">${recent.map((p) => `
        <button class="thumb ${state.aiSel.has(p.id) ? 'picked' : ''}" data-act="ai-pick" data-id="${p.id}">
          <img src="${photoUrl(p)}" alt="" loading="lazy"><span>${esc(p.date.slice(5))} · ${esc(ZONES[p.zone])}</span>
        </button>`).join('')}</div>
        <p class="muted small">Выбрано: ${state.aiSel.size}. Можно добавить старые фото той же зоны для сравнения.</p>`
        : '<p class="muted">Сначала добавьте фото во вкладке «Фото».</p>'}
    </div>

    <div class="card">
      <h3>2. Отправьте в Claude</h3>
      <button class="btn primary wide" data-act="ai-share" ${state.aiSel.size ? '' : 'disabled'}>Поделиться фото и отчётом → Claude</button>
      <button class="btn wide" data-act="ai-copy">Скопировать текст отчёта</button>
      <p class="muted small">В меню «Поделиться» выберите Claude. Если текст не подтянулся — скопируйте его кнопкой выше и вставьте в чат.</p>
    </div>

    <div class="card">
      <h3>3. Сохраните заключение</h3>
      <textarea id="ai-answer" rows="5" placeholder="Скопируйте ответ Claude целиком и вставьте сюда"></textarea>
      <div class="row2">
        <button class="btn" data-act="ai-paste">Вставить из буфера</button>
        <button class="btn primary" data-act="ai-save">Сохранить</button>
      </div>
    </div>

    ${withScores.length ? `<div class="card"><h3>Динамика по оценкам ИИ</h3>${lineChart(withScores)}</div>` : ''}

    ${state.analyses.length ? `<h3 class="section">История заключений</h3><div class="list">${state.analyses.map((a) => `
      <button class="card item" data-act="analysis" data-id="${a.id}">
        <div class="item-main">
          <div class="item-name">${esc(fmtDay(a.date, { day: 'numeric', month: 'long', year: 'numeric' }))}</div>
          <div class="muted">${a.scores ? Object.entries(SCORE_LABELS).filter(([k]) => a.scores[k] != null).map(([k, l]) => `${l} ${a.scores[k]}/10`).join(' · ') : 'без числовых оценок'}</div>
          <div class="muted small clamp">${esc(a.text.replace(/HAIRLOG[^\n]*/i, '').slice(0, 160))}</div>
        </div><div class="chev">›</div>
      </button>`).join('')}</div>` : ''}`;
}

function lineChart(list) {
  const W = 320, H = 160, P = 24;
  const keys = Object.keys(SCORE_LABELS).filter((k) => list.some((a) => typeof a.scores[k] === 'number'));
  const n = list.length;
  const x = (i) => (n === 1 ? W / 2 : P + (i * (W - 2 * P)) / (n - 1));
  const y = (v) => H - P - (v / 10) * (H - 2 * P);
  const grid = [0, 5, 10].map((v) => `<line x1="${P}" x2="${W - P}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="4" y="${y(v) + 4}" class="axis">${v}</text>`).join('');
  const lines = keys.map((k, ki) => {
    const pts = list.map((a, i) => (typeof a.scores[k] === 'number' ? [x(i), y(a.scores[k])] : null)).filter(Boolean);
    return `<polyline points="${pts.map((p) => p.join(',')).join(' ')}" class="s${ki}" fill="none"/>` +
      pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" class="s${ki}"/>`).join('');
  }).join('');
  const labels = list.map((a, i) => (n <= 6 || i === 0 || i === n - 1 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="axis">${a.date.slice(5).split('-').reverse().join('.')}</text>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart">${grid}${lines}${labels}</svg>
    <div class="legend">${keys.map((k, ki) => `<span><i class="s${ki}"></i>${SCORE_LABELS[k]}</span>`).join('')}</div>`;
}

function aiPayload() {
  const photos = state.photos.filter((p) => state.aiSel.has(p.id)).sort((a, b) => a.date.localeCompare(b.date));
  const text = buildReport({ items: state.items, logs: state.logs, photos, allPhotos: state.photos, analyses: state.analyses, transplant: state.transplant });
  return { photos, text };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    openSheet(`<h2>Скопируйте вручную</h2><textarea rows="14" readonly>${esc(text)}</textarea>`);
    return false;
  }
}

async function aiShare() {
  const { photos, text } = aiPayload();
  const files = photos.map((p, i) => new File([p.blob], `hair_${i + 1}_${p.date}_${p.zone}.jpg`, { type: 'image/jpeg' }));
  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, text });
    } catch (e) {
      if (e.name !== 'AbortError') toast('Не удалось поделиться: ' + e.message);
    }
  } else {
    if (await copyText(text)) toast('Отчёт скопирован. Это устройство не умеет делиться фото — приложите их в Claude вручную');
  }
}

async function aiSave() {
  const text = $('#ai-answer').value.trim();
  if (!text) return toast('Вставьте ответ Claude');
  const scores = parseHairlog(text);
  const rec = { id: uid(), created: new Date().toISOString(), date: today(), text, scores, photoIds: [...state.aiSel] };
  await db.put('analyses', rec);
  state.analyses.unshift(rec);
  toast(scores ? 'Заключение и оценки сохранены' : 'Сохранено (строка HAIRLOG не найдена — график не обновится)');
  render();
}

function showAnalysis(id) {
  const a = state.analyses.find((x) => x.id === id);
  openSheet(`
    <h2>Заключение от ${esc(fmtDay(a.date, { day: 'numeric', month: 'long', year: 'numeric' }))}</h2>
    ${a.photoIds?.length ? `<div class="preview">${a.photoIds.map((pid) => state.photos.find((p) => p.id === pid)).filter(Boolean).map((p) => `<img src="${photoUrl(p)}" alt="">`).join('')}</div>` : ''}
    <div class="answer">${esc(a.text)}</div>
    <button class="btn danger wide" data-act="del-analysis" data-id="${a.id}">Удалить заключение</button>`);
}

// ----- Аналитика -----
function viewStats() {
  const t = today();
  const now = new Date();
  if (!state.items.length) return '<div class="empty"><div class="empty-ico">📊</div><p>Аналитика появится, когда вы добавите схему и начнёте отмечать приёмы.</p></div>';
  const first = state.items.map((i) => i.startDate).sort()[0];
  let from = state.period === 'all' ? first : S.addDays(t, -(state.period - 1));
  if (from < first) from = first;
  if (from > t) from = t;
  const st = S.computeStats(state.items, state.logs, from, t, now);
  const tot = st.total;
  const streak = S.currentStreak(state.items, state.logs, now);

  // недельная динамика
  const weeks = [];
  for (let w = 11; w >= 0; w--) {
    const end = S.addDays(t, -7 * w);
    const start = S.addDays(end, -6);
    if (end < first) continue;
    const s = S.computeStats(state.items, state.logs, start < first ? first : start, end, now).total;
    weeks.push({ end, s });
  }

  // календарь (пн — первый столбец)
  const lead = (S.parseYmd(st.perDay[0].date).getDay() + 6) % 7;
  const cells = Array(lead).fill('<i class="cell blank"></i>').concat(st.perDay.map((d) =>
    `<i class="cell r${d.rating || 0}${d.date === t ? ' today' : ''}" title="${d.date}: ${pct(d.score)}"></i>`)).join('');

  const periods = [[7, '7 дней'], [30, '30 дней'], [90, '90 дней'], ['all', 'Всё время']];
  return `
    <div class="chips-scroll">${periods.map(([k, l]) => `<button class="chip-btn ${state.period === k ? 'on' : ''}" data-act="period" data-period="${k}">${l}</button>`).join('')}</div>

    <div class="card hero r${tot.rating || 0}">
      <div class="hero-num">${tot.rating || '—'}<small>/5</small></div>
      <div>
        <div class="hero-label">${tot.rating ? S.RATING_LABELS[tot.rating] : 'Нет данных'}</div>
        ${stars(tot.rating)}
        <div class="muted">Выполнение схемы: <b>${pct(tot.score)}</b></div>
      </div>
    </div>

    <div class="tiles">
      <div class="tile"><b>${tot.planned}</b><span>должно было быть</span></div>
      <div class="tile ok"><b>${tot.ontime}</b><span>вовремя</span></div>
      <div class="tile late"><b>${tot.late}</b><span>с опозданием</span></div>
      <div class="tile skip"><b>${tot.skipped}</b><span>пропущено</span></div>
      <div class="tile miss"><b>${tot.missed}</b><span>не отмечено</span></div>
      <div class="tile"><b>${streak}</b><span>дн. подряд без пропусков</span></div>
    </div>
    ${tot.pending ? `<p class="muted small">Ещё ожидают сегодня: ${tot.pending} — они не влияют на рейтинг, пока не наступило их время.</p>` : ''}

    <div class="card">
      <h3>Календарь</h3>
      <div class="cal-head">${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => `<span>${d}</span>`).join('')}</div>
      <div class="cal">${cells}</div>
      <div class="legend">${[5, 4, 3, 2, 1].map((r) => `<span><i class="cell r${r}"></i>${r}</span>`).join('')}<span><i class="cell r0"></i>нет</span></div>
    </div>

    ${weeks.length > 1 ? `<div class="card"><h3>По неделям</h3><div class="bars">${weeks.map(({ end, s }) => `
      <div class="bar"><div class="bar-fill r${s.rating || 0}" style="height:${Math.round((s.score ?? 0) * 100)}%"></div><span>${end.slice(8)}.${end.slice(5, 7)}</span></div>`).join('')}</div></div>` : ''}

    <div class="card">
      <h3>По препаратам</h3>
      ${st.perItem.map((p) => `
        <div class="pi">
          <div class="pi-top"><span>${KIND_ICON[p.item.kind] || '💊'} ${esc(p.item.name)}</span>${stars(p.rating)}</div>
          <div class="progress"><div class="r${p.rating || 0}" style="width:${Math.round((p.score ?? 0) * 100)}%"></div></div>
          <div class="muted small">${p.ontime + p.late} из ${p.planned} · вовремя ${p.ontime} · поздно ${p.late} · пропуск ${p.skipped + p.missed}${p.pending ? ` · ждут ${p.pending}` : ''}</div>
        </div>`).join('') || '<p class="muted">Нет приёмов за период.</p>'}
    </div>

    <details class="card info"><summary>Как считается рейтинг</summary>
      <p>Каждый запланированный приём даёт баллы: вовремя (±${S.ON_TIME_MIN} мин) — 1, с опозданием — 0,75, пропуск или не отмечено — 0. Процент = баллы / число приёмов.</p>
      <p>5 «Супер» — от 95%, 4 «Хорошо» — от 85%, 3 «Средне» — от 70%, 2 «Слабо» — от 50%, 1 «Плохо» — ниже 50%.</p>
    </details>`;
}

// ----- Настройки / резервная копия -----
async function showSettings() {
  let usage = '';
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    usage = `Занято: ${(e.usage / 1048576).toFixed(1)} МБ`;
  }
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  openSheet(`
    <h2>Данные</h2>
    <p class="muted">Всё хранится только на этом iPhone. ${usage}. ${persisted ? 'Хранилище защищено от автоочистки.' : ''}</p>
    <p>Делайте резервную копию раз в пару недель и сохраняйте в «Файлы» или iCloud Drive.</p>
    <button class="btn primary wide" data-act="export" data-photos="1">Резервная копия (с фото)</button>
    <button class="btn wide" data-act="export" data-photos="0">Резервная копия (без фото)</button>
    <label class="btn wide">Восстановить из копии<input type="file" accept="application/json,.json" hidden data-import></label>
    <button class="btn danger wide" data-act="wipe">Удалить все данные</button>
    <p class="muted small">Версия ${APP_VERSION}</p>`);
}

async function exportData(withPhotos) {
  toast('Готовлю файл…');
  const photos = withPhotos
    ? await Promise.all(state.photos.map(async (p) => ({ ...p, blob: await blobToDataUrl(p.blob), thumb: await blobToDataUrl(p.thumb) })))
    : [];
  const data = { app: 'hairgrowth', version: 1, exported: new Date().toISOString(), items: state.items, logs: [...state.logs.values()], analyses: state.analyses, meta: [state.transplant], photos };
  await shareOrDownload(new File([JSON.stringify(data)], `hairgrowth-${today()}.json`, { type: 'application/json' }));
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'hairgrowth') throw new Error('Это не копия приложения «Рост волос»');
    const keepPhotos = !data.photos?.length;
    if (!confirm(`Заменить текущие данные копией от ${data.exported?.slice(0, 10)}?${keepPhotos ? ' Фото в копии нет — текущие фото останутся.' : ''}`)) return;
    for (const s of ['items', 'logs', 'analyses', 'meta']) {
      await db.clear(s);
      for (const r of data[s] || []) await db.put(s, r);
    }
    if (!keepPhotos) {
      await db.clear('photos');
      for (const p of data.photos) await db.put('photos', { ...p, blob: await dataUrlToBlob(p.blob), thumb: await dataUrlToBlob(p.thumb) });
    }
    await loadAll();
    closeSheet();
    toast('Данные восстановлены');
    render();
  } catch (e) {
    toast('Ошибка: ' + e.message);
  }
}

// ---------- действия ----------
const actions = {
  tab: (el) => { state.tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
  day: (el) => {
    const d = Number(el.dataset.delta);
    state.day = d ? S.addDays(state.day, d) : today();
    render();
  },
  take: (el) => {
    const inst = findInst(el.dataset.key);
    const now = new Date();
    const diff = Math.abs(now - S.at(inst.date, inst.time)) / 60000;
    if (inst.date === today() && diff <= S.ON_TIME_MIN) saveLog(inst, 'taken', now);
    else askTakenTime(inst);
  },
  'take-at': (el) => {
    const inst = findInst(el.dataset.key);
    const mode = el.dataset.mode;
    const time = mode === 'plan' ? inst.time : $('#take-time').value || inst.time;
    closeSheet();
    saveLog(inst, 'taken', mode === 'now' ? new Date() : S.at(inst.date, time));
  },
  skip: (el) => saveLog(findInst(el.dataset.key), 'skipped', new Date()),
  undo: async (el) => {
    await db.del('logs', el.dataset.key);
    state.logs.delete(el.dataset.key);
    render();
  },
  'new-item': () => itemForm(null),
  'edit-item': (el) => itemForm(state.items.find((i) => i.id === el.dataset.id)),
  'add-time': () => $('#times').insertAdjacentHTML('beforeend', timeRow('21:00')),
  'del-time': (el) => { if ($$('.time-row').length > 1) el.closest('.time-row').remove(); },
  'end-item': async (el) => {
    const it = state.items.find((i) => i.id === el.dataset.id);
    if (!confirm(`Завершить курс «${it.name}» сегодняшним днём? История сохранится.`)) return;
    it.endDate = today();
    await db.put('items', it);
    closeSheet();
    render();
  },
  'del-item': async (el) => {
    const it = state.items.find((i) => i.id === el.dataset.id);
    if (!confirm(`Удалить «${it.name}» вместе со всей историей приёмов? Это нельзя отменить. Чтобы сохранить статистику, лучше «Завершить курс».`)) return;
    await db.del('items', it.id);
    for (const k of [...state.logs.keys()]) if (k.startsWith(it.id + '|')) { await db.del('logs', k); state.logs.delete(k); }
    state.items = state.items.filter((i) => i !== it);
    closeSheet();
    render();
  },
  ics: () => {
    const { text, count } = buildIcs(state.items, location.href.split('#')[0]);
    if (!count) return toast('Нет активных напоминаний');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  },
  'ics-share': () => {
    const { text } = buildIcs(state.items, location.href.split('#')[0]);
    shareOrDownload(new File([text], 'hair-reminders.ics', { type: 'text/calendar' }));
  },
  zone: (el) => { state.zone = el.dataset.zone; render(); },
  photo: (el) => showPhoto(el.dataset.id),
  compare: (el) => showCompare(el.dataset.id),
  'del-photo': async (el) => {
    if (!confirm('Удалить это фото?')) return;
    await db.del('photos', el.dataset.id);
    state.photos = state.photos.filter((p) => p.id !== el.dataset.id);
    state.aiSel?.delete(el.dataset.id);
    closeSheet();
    render();
  },
  'ai-pick': (el) => {
    const id = el.dataset.id;
    state.aiSel.has(id) ? state.aiSel.delete(id) : state.aiSel.add(id);
    const answer = $('#ai-answer')?.value;
    render();
    if (answer) $('#ai-answer').value = answer;
  },
  'ai-share': aiShare,
  'ai-copy': async () => { if (await copyText(aiPayload().text)) toast('Отчёт скопирован — вставьте его в чат Claude'); },
  'ai-paste': async () => {
    try { $('#ai-answer').value = await navigator.clipboard.readText(); } catch { toast('Вставьте вручную: долгое нажатие → Вставить'); }
  },
  'ai-save': aiSave,
  analysis: (el) => showAnalysis(el.dataset.id),
  'del-analysis': async (el) => {
    if (!confirm('Удалить это заключение?')) return;
    await db.del('analyses', el.dataset.id);
    state.analyses = state.analyses.filter((a) => a.id !== el.dataset.id);
    closeSheet();
    render();
  },
  period: (el) => { state.period = el.dataset.period === 'all' ? 'all' : Number(el.dataset.period); render(); },
  'tx-edit': transplantForm,
  'tx-cut-del': async (el) => {
    state.transplant.haircuts = state.transplant.haircuts.filter((c) => c.date !== el.dataset.date);
    await saveTransplant();
    transplantForm();
  },
  'z3d-zone': (el) => selectZone(el.dataset.id),
  'z3d-photos': (el) => { state.zone = el.dataset.zone; actions.tab({ dataset: { tab: 'photos' } }); },
  'z3d-rotate': (el) => { if (zoneScene) { zoneScene.setAutoRotate(!zoneScene.autoRotate); el.classList.toggle('off', !zoneScene.autoRotate); } },
  'z3d-home': () => zoneScene?.resetView(),
  'z3d-grow': (el) => zoneScene?.startGrowth(el.dataset.mode),
  'z3d-stop': () => zoneScene?.stopGrowth(),
  settings: showSettings,
  export: (el) => exportData(el.dataset.photos === '1'),
  wipe: async () => {
    if (!confirm('Удалить ВСЕ данные: схему, отметки, фото и заключения? Это нельзя отменить.')) return;
    for (const s of STORES) await db.clear(s);
    await loadAll();
    closeSheet();
    render();
  },
  'close-sheet': closeSheet,
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act], .tabbar button[data-tab]');
  if (!el || el.disabled) return;
  if (!el.dataset.act) return actions.tab(el);
  actions[el.dataset.act]?.(el, e);
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('[data-photo-input]')) { onPhotosPicked([...t.files]); t.value = ''; }
  else if (t.matches('[data-import]')) { importData(t.files[0]); t.value = ''; }
  else if (t.id === 'mode') syncModeFields();
  else if (t.name === 'zone' && t.closest('#photo-form')) {
    $('#photo-style').value = PHOTO_GUIDE[t.value].style;
    $('#photo-guide').innerHTML = guideCard(t.value);
  }
  else if (t.id === 'cmp-a' || t.id === 'cmp-b') {
    const p = state.photos.find((x) => x.id === t.value);
    $(t.id === 'cmp-a' ? '#cmp-img-a' : '#cmp-img-b').src = photoUrl(p, 'blob');
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'cmp-range') {
    const v = e.target.value;
    $('#cmp-img-b').style.clipPath = `inset(0 0 0 ${v}%)`;
    $('.cmp-line').style.left = v + '%';
  }
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'item-form') submitItem(e.target);
  if (e.target.id === 'photo-form') submitPhotos(e.target);
  if (e.target.id === 'tx-form') {
    const f = new FormData(e.target);
    Object.assign(state.transplant, {
      date: f.get('date'), grafts: Number(f.get('grafts')) || 0, method: f.get('method'),
      zones: f.getAll('zones'), donor: f.getAll('donor'),
    });
    closeSheet();
    saveTransplant();
    toast('Сохранено');
  }
  if (e.target.id === 'cut-form') {
    const f = new FormData(e.target);
    state.transplant.haircuts = [...(state.transplant.haircuts || []), { date: f.get('date'), note: f.get('note') }];
    saveTransplant().then(transplantForm);
    toast('Стрижка отмечена — первая съёмка после неё станет новой точкой отсчёта');
  }
});

$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

// Обновлять статусы («пора!», «не отмечено») при возврате в приложение и раз в минуту.
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#sheet').classList.contains('open')) render(); });
setInterval(() => { if (!document.hidden && state.tab === 'today' && !$('#sheet').classList.contains('open')) render(); }, 60000);

// ---------- запуск ----------
(async function init() {
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!standalone && /iPhone|iPad/.test(navigator.userAgent)) $('#install-hint').hidden = false;
  navigator.storage?.persist?.();
  await loadAll();
  render();
  if ('serviceWorker' in navigator) {
    // Проверяем обновление при каждом запуске; когда новая версия активировалась — перезагружаемся один раз.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !sessionStorage.getItem('hg-reloaded')) {
        sessionStorage.setItem('hg-reloaded', '1');
        location.reload();
      }
    });
    navigator.serviceWorker.register('sw.js').then((r) => r.update()).catch(() => {});
  }
})();
