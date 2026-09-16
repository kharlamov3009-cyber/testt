/* ═══════════════════════════════════════════════════════════════════════════
   🌧 ТИХИЙ ДОЖДЬ — Backend + Bot + Mini App + Owner Panel
   Один файл. Запуск: npm install && npm start
   ═══════════════════════════════════════════════════════════════════════════ */

import express from 'express';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { Telegraf, Markup } from 'telegraf';

/* ═══════════════ 1. КОНФИГ ═══════════════ */
const BOT_TOKEN   = '8609372755:AAFLPUgTq4i4CoTmUVkw3xE7O2RLf1cJAuc';
const CHAT_ID     = '-5585736357';
const OWNER_ID    = 6618163794;
const PORT        = process.env.PORT || 3000;
const WEBAPP_URL  = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
const RATE_WINDOW = 7 * 24 * 60 * 60 * 1000;

/* ═══════════════ 2. БАЗА ДАННЫХ ═══════════════ */
const db = new Database('tihiy-dozhd.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT,
    first_name TEXT,
    type TEXT NOT NULL,
    roles TEXT,
    payload TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    reason TEXT,
    created_at INTEGER NOT NULL,
    reviewed_at INTEGER,
    reviewed_by INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_user ON applications(user_id);
  CREATE INDEX IF NOT EXISTS idx_status ON applications(status);

  CREATE TABLE IF NOT EXISTS rate_limit (
    user_id INTEGER PRIMARY KEY,
    last_submit INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dialogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL,
    moderator_id INTEGER NOT NULL,
    candidate_id INTEGER NOT NULL,
    direction TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const dbApi = {
  save({ userId, username, firstName, type, roles, payload }) {
    return db.prepare(`
      INSERT INTO applications (user_id, username, first_name, type, roles, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, username || null, firstName || null,
           type, roles ? JSON.stringify(roles) : null,
           JSON.stringify(payload), Date.now()).lastInsertRowid;
  },
  setStatus(id, status, reason, reviewerId) {
    db.prepare(`UPDATE applications SET status=?, reason=?, reviewed_at=?, reviewed_by=? WHERE id=?`)
      .run(status, reason || null, Date.now(), reviewerId || null, id);
  },
  get(id) { return db.prepare(`SELECT * FROM applications WHERE id=?`).get(id); },
  getPending(limit = 20) {
    return db.prepare(`SELECT * FROM applications WHERE status='pending' ORDER BY created_at DESC LIMIT ?`).all(limit);
  },
  checkRate(userId) {
    const row = db.prepare(`SELECT last_submit FROM rate_limit WHERE user_id=?`).get(userId);
    if (!row) return { allowed: true };
    const elapsed = Date.now() - row.last_submit;
    if (elapsed >= RATE_WINDOW) return { allowed: true };
    return { allowed: false, retryAfterMs: RATE_WINDOW - elapsed };
  },
  setRate(userId) {
    db.prepare(`
      INSERT INTO rate_limit (user_id, last_submit) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET last_submit=excluded.last_submit
    `).run(userId, Date.now());
  },
  stats() {
    const total      = db.prepare(`SELECT COUNT(*) c FROM applications`).get().c;
    const pending    = db.prepare(`SELECT COUNT(*) c FROM applications WHERE status='pending'`).get().c;
    const approved   = db.prepare(`SELECT COUNT(*) c FROM applications WHERE status='approved'`).get().c;
    const rejected   = db.prepare(`SELECT COUNT(*) c FROM applications WHERE status='rejected'`).get().c;
    const anketa     = db.prepare(`SELECT COUNT(*) c FROM applications WHERE type='anketa'`).get().c;
    const complaints = db.prepare(`SELECT COUNT(*) c FROM applications WHERE type='complaint'`).get().c;
    const avgRow     = db.prepare(`SELECT AVG(reviewed_at-created_at) avg FROM applications WHERE reviewed_at IS NOT NULL`).get();
    const avgMs      = avgRow.avg || 0;
    return {
      total, pending, approved, rejected, anketa, complaints,
      approvalRate: total ? Math.round((approved/total)*100) : 0,
      avgReviewHuman: humanMs(avgMs)
    };
  },
  users() { return db.prepare(`SELECT DISTINCT user_id FROM applications`).all(); },
  saveDialog({ appId, moderatorId, candidateId, direction, text }) {
    db.prepare(`INSERT INTO dialogs (app_id, moderator_id, candidate_id, direction, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(appId, moderatorId, candidateId, direction, text, Date.now());
  }
};

function humanMs(ms) {
  if (!ms) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч ${m % 60} мин`;
  return `${Math.floor(h / 24)} д ${h % 24} ч`;
}

/* ═══════════════ 3. ФОРМАТИРОВАНИЕ ═══════════════ */
const LABELS = {
  age: 'Возраст', nickname: 'Псевдоним', gender: 'Пол', timezone: 'Часовой пояс',
  employment: 'Занятость (ч/день)', posts: 'Постов/нед', experience: 'Опыт',
  burnout: 'Выгорания', rest: 'Рест', conflict: 'Конфликтность', filter: 'Фильтр речи',
  deadlines: 'Дедлайны', rules: 'Правила', why: 'Почему к нам', confirm: 'Подтверждение',
  ch1: 'Проверки: проблема', ch2: 'Проверки: роль', ch3: 'Проверки: аргументы',
  ch4: 'Проверки: расположить', ch5: 'Проверки: формат', ch6: 'Проверки: споры',
  ch7: 'Проверки: аргумент', ch8: 'Проверки: пробный пост', ch9: 'Проверки: исправление',
  in1: 'Интервью: расположить', in2: 'Интервью: вопросы', in3: 'Интервью: ответы'
};

function esc(s) {
  return String(s ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatAnketa(appId, user, payload) {
  const d = payload.data || {};
  const roles = (payload.roles || []).join(' + ');
  const L = [
    `🌧 <b>НОВАЯ АНКЕТА</b>  <code>#${appId}</code>`,
    `👤 ${esc(user.first_name)} ${esc(user.last_name || '')} (@${esc(user.username || '—')})`,
    `🆔 <code>${user.id}</code>`,
    `💼 <b>${esc(roles)}</b>`,
    `🕐 ${new Date(payload.timestamp || Date.now()).toLocaleString('ru-RU')}`,
    `━━━━━━━━━━━━━━━━━━`,
    `<b>1.</b> Возраст: ${esc(d.age)}`,
    `<b>2.</b> Псевдоним: ${esc(d.nickname)}`,
    `<b>3.</b> Пол: ${esc(d.gender)}`,
    `<b>4.</b> Часовой пояс: ${esc(d.timezone)}`,
    `<b>6.</b> Занятость: ${esc(d.employment)}`,
    `<b>7.</b> Постов/нед: ${esc(d.posts)}`,
    `<b>8.</b> Опыт: ${esc(d.experience)}`,
    `━━━━━━━━━━━━━━━━━━`,
    `<b>9.</b> Выгорания: ${esc(d.burnout)}`,
    `<b>10.</b> Рест: ${esc(d.rest)}`,
    `<b>11.</b> Конфликтность: ${esc(d.conflict)}`,
    `<b>12.</b> Фильтр речи: ${esc(d.filter)}`,
    `<b>13.</b> Дедлайны: ${esc(d.deadlines)}`,
    `<b>14.</b> Правила: ${esc(d.rules)}`,
    `<b>15.</b> Почему: ${esc(d.why)}`,
    `<b>16.</b> Подтверждение: ${esc(d.confirm)}`
  ];
  if ((payload.roles || []).includes('Проверки')) {
    L.push(`━━━━━━━━━━━━━━━━━━`, `<b>🔍 ПРОВЕРКИ</b>`);
    ['ch1','ch2','ch3','ch4','ch5','ch6','ch7','ch8','ch9'].forEach((id, i) => {
      L.push(`<b>${i+1}.</b> ${LABELS[id]}:\n${esc(d[id])}`);
    });
  }
  if ((payload.roles || []).includes('Интервью')) {
    L.push(`━━━━━━━━━━━━━━━━━━`, `<b>🎤 ИНТЕРВЬЮ</b>`);
    ['in1','in2','in3'].forEach((id, i) => {
      L.push(`<b>${i+1}.</b> ${LABELS[id]}:\n${esc(d[id])}`);
    });
  }
  return L.join('\n');
}

function formatComplaint(appId, user, payload) {
  const c = payload.complaint || {};
  return [
    `🚨 <b>НОВАЯ ЖАЛОБА</b>  <code>#${appId}</code>`,
    `👤 От: ${esc(user.first_name)} (@${esc(user.username || '—')})`,
    `🆔 <code>${user.id}</code>`,
    `🕐 ${new Date(payload.timestamp || Date.now()).toLocaleString('ru-RU')}`,
    `━━━━━━━━━━━━━━━━━━`,
    `<b>Тип:</b> ${esc(c.type)}`,
    `<b>Нарушитель:</b> ${esc(c.nick)}`,
    `<b>Описание:</b>\n${esc(c.desc)}`,
    `<b>Доказательства:</b>\n${esc(c.proof)}`
  ].join('\n');
}

function buildKeyboard(appId, type) {
  if (type === 'anketa') {
    return { inline_keyboard: [
      [ { text: '✅ Одобрить', callback_data: `approve:${appId}` },
        { text: '❌ Отклонить', callback_data: `reject:${appId}` } ],
      [ { text: '❓ Вопрос', callback_data: `ask:${appId}` },
        { text: '📄 Карточка', callback_data: `card:${appId}` } ]
    ]};
  }
  return { inline_keyboard: [[
    { text: '✅ Принять', callback_data: `c_ok:${appId}` },
    { text: '❌ Отклонить', callback_data: `c_no:${appId}` }
  ]]};
}

/* ═══════════════ 4. БОТ ═══════════════ */
const bot = new Telegraf(BOT_TOKEN);
const pendingReject = new Map();
const pendingAsk = new Map();
const pendingBroadcast = new Set();

async function notifyModeration(appId, user, payload) {
  const text = payload.type === 'anketa'
    ? formatAnketa(appId, user, payload)
    : formatComplaint(appId, user, payload);
  return bot.telegram.sendMessage(CHAT_ID, text, {
    parse_mode: 'HTML',
    reply_markup: buildKeyboard(appId, payload.type),
    disable_web_page_preview: true
  });
}

async function notifyCandidate(userId, action, reason, type) {
  let text;
  if (type === 'anketa') {
    if (action === 'approve') text = '🎉 <b>Поздравляем!</b>\n\nВаша анкета одобрена. С вами свяжется старший администратор.';
    else {
      text = `😔 <b>К сожалению, ваша анкета отклонена.</b>`;
      if (reason) text += `\n\n<b>Причина:</b> ${esc(reason)}`;
      text += `\n\nПопробуйте снова через 7 дней.`;
    }
  } else {
    if (action === 'approve') text = '✅ <b>Жалоба принята.</b>\n\nМодераторы рассмотрят её скоро.';
    else {
      text = `❌ <b>Жалоба отклонена.</b>`;
      if (reason) text += `\n\n<b>Причина:</b> ${esc(reason)}`;
    }
  }
  try { await bot.telegram.sendMessage(userId, text, { parse_mode: 'HTML' }); }
  catch (e) { console.error(`DM fail ${userId}:`, e.message); }
}

bot.start((ctx) => {
  const isOwner = ctx.from.id === OWNER_ID;
  const buttons = [
    [Markup.button.webApp('📝 Заполнить анкету', WEBAPP_URL)],
    [Markup.button.webApp('🚨 Подать жалобу', WEBAPP_URL + '#complaint')]
  ];
  if (isOwner) buttons.push([Markup.button.callback('👑 Панель владельца', 'owner:panel')]);
  ctx.reply(
    `🌧 <b>Добро пожаловать в бот канала «Тихий дождь»!</b>\n\n` +
    `Здесь вы можете:\n• заполнить анкету\n• подать жалобу\n\nВыберите действие:`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
  );
});

bot.action(/^approve:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const row = dbApi.get(id);
  if (!row) return ctx.answerCbQuery('Не найдено');
  if (row.status !== 'pending') return ctx.answerCbQuery('Уже рассмотрено');
  dbApi.setStatus(id, 'approved', null, ctx.from.id);
  await ctx.answerCbQuery('✅ Одобрено');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(`✅ Заявка #${id} одобрена (${ctx.from.first_name})`);
  await notifyCandidate(row.user_id, 'approve', null, row.type);
});

bot.action(/^reject:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const row = dbApi.get(id);
  if (!row) return ctx.answerCbQuery('Не найдено');
  if (row.status !== 'pending') return ctx.answerCbQuery('Уже рассмотрено');
  pendingReject.set(ctx.from.id, { appId: id, type: row.type, userId: row.user_id });
  await ctx.answerCbQuery();
  await ctx.reply(`✍️ Причина отказа для #${id} (одним сообщением).\n/skip — без причины.`);
});

bot.action(/^ask:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const row = dbApi.get(id);
  if (!row) return ctx.answerCbQuery('Не найдено');
  pendingAsk.set(ctx.from.id, { appId: id, userId: row.user_id });
  await ctx.answerCbQuery();
  await ctx.reply(`❓ Напишите вопрос для кандидата (#${id}).`);
});

bot.action(/^card:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const row = dbApi.get(id);
  if (!row) return ctx.answerCbQuery('Не найдено');
  const payload = JSON.parse(row.payload);
  const user = { id: row.user_id, username: row.username, first_name: row.first_name };
  const text = row.type === 'anketa' ? formatAnketa(id, user, payload) : formatComplaint(id, user, payload);
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(`📄 <b>Карточка #${id}</b>\n\n${text}`, { disable_web_page_preview: true });
});

bot.action(/^c_ok:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const row = dbApi.get(id);
  if (!row) return ctx.answerCbQuery('Не найдено');
  dbApi.setStatus(id, 'approved', null, ctx.from.id);
  await ctx.answerCbQuery('✅ Принято');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await notifyCandidate(row.user_id, 'approve', null, 'complaint');
});

bot.action(/^c_no:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const row = dbApi.get(id);
  if (!row) return ctx.answerCbQuery('Не найдено');
  dbApi.setStatus(id, 'rejected', 'Жалоба отклонена', ctx.from.id);
  await ctx.answerCbQuery('❌ Отклонено');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await notifyCandidate(row.user_id, 'reject', 'Жалоба отклонена модератором', 'complaint');
});

bot.on('text', async (ctx, next) => {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();

  if (pendingReject.has(uid)) {
    const { appId, userId, type } = pendingReject.get(uid);
    pendingReject.delete(uid);
    const reason = text === '/skip' ? null : text;
    dbApi.setStatus(appId, 'rejected', reason, uid);
    await ctx.reply(`❌ Заявка #${appId} отклонена.`);
    await notifyCandidate(userId, 'reject', reason, type);
    return;
  }
  if (pendingAsk.has(uid)) {
    const { appId, userId } = pendingAsk.get(uid);
    pendingAsk.delete(uid);
    try {
      await bot.telegram.sendMessage(userId,
        `❓ <b>Вопрос от модератора по заявке #${appId}:</b>\n\n${esc(text)}\n\nОтветьте в этот чат.`,
        { parse_mode: 'HTML' });
      dbApi.saveDialog({ appId, moderatorId: uid, candidateId: userId, direction: 'm2c', text });
      await ctx.reply('✅ Вопрос отправлен.');
    } catch (e) { await ctx.reply(`⚠️ Не доставлено: ${e.message}`); }
    return;
  }
  if (pendingBroadcast.has(uid)) {
    pendingBroadcast.delete(uid);
    if (text === '/skip') return ctx.reply('Отменено.');
    const users = dbApi.users();
    let sent = 0, failed = 0;
    for (const u of users) {
      try { await bot.telegram.sendMessage(u.user_id, text, { parse_mode: 'HTML' }); sent++; await new Promise(r => setTimeout(r, 60)); }
      catch { failed++; }
    }
    return ctx.reply(`📢 Рассылка: ✅ ${sent} / ❌ ${failed}`);
  }
  return next();
});

/* ═══════════════ 5. ПАНЕЛЬ ВЛАДЕЛЬЦА ═══════════════ */
function ownerOnly(ctx) {
  if (ctx.from.id !== OWNER_ID) { ctx.answerCbQuery?.('Только для владельца'); return false; }
  return true;
}

async function showOwnerPanel(ctx) {
  const s = dbApi.stats();
  const text =
    `👑 <b>Панель владельца</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `📊 Всего заявок: <b>${s.total}</b>\n` +
    `⏳ В ожидании: <b>${s.pending}</b>\n` +
    `✅ Одобрено: <b>${s.approved}</b>\n` +
    `❌ Отклонено: <b>${s.rejected}</b>\n` +
    `📝 Анкет: <b>${s.anketa}</b>\n` +
    `🚨 Жалоб: <b>${s.complaints}</b>\n` +
    `📈 % одобрений: <b>${s.approvalRate}%</b>\n` +
    `⏱ Среднее время: <b>${s.avgReviewHuman}</b>`;
  const keyboard = { inline_keyboard: [
    [ { text: '⏳ Ожидающие', callback_data: 'owner:pending' },
      { text: '🔄 Обновить', callback_data: 'owner:panel' } ],
    [ { text: '📊 Статистика', callback_data: 'owner:stats' },
      { text: '📄 CSV', callback_data: 'owner:csv' } ],
    [ { text: '📢 Рассылка', callback_data: 'owner:broadcast' } ]
  ]};
  const opts = { parse_mode: 'HTML', reply_markup: keyboard };
  if (ctx.callbackQuery?.message) await ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
  else await ctx.reply(text, opts);
}

bot.action('owner:panel', async (ctx) => { if (!ownerOnly(ctx)) return; await ctx.answerCbQuery(); await showOwnerPanel(ctx); });
bot.command('panel', async (ctx) => { if (ctx.from.id !== OWNER_ID) return; await showOwnerPanel(ctx); });

bot.action('owner:stats', async (ctx) => {
  if (!ownerOnly(ctx)) return;
  await ctx.answerCbQuery();
  const s = dbApi.stats();
  await ctx.replyWithHTML(
    `📊 <b>Статистика</b>\n━━━━━━━━━━━━━━━━━━\n` +
    `Всего: ${s.total}\nОжидают: ${s.pending}\nОдобрено: ${s.approved}\nОтклонено: ${s.rejected}\n` +
    `Анкет: ${s.anketa}\nЖалоб: ${s.complaints}\n% одобрений: ${s.approvalRate}%\nСреднее: ${s.avgReviewHuman}`
  );
});

bot.action('owner:pending', async (ctx) => {
  if (!ownerOnly(ctx)) return;
  await ctx.answerCbQuery();
  const rows = dbApi.getPending(15);
  if (!rows.length) return ctx.reply('✅ Нет ожидающих заявок.');
  const text = rows.map(r =>
    `#${r.id} · ${r.type === 'anketa' ? '📝' : '🚨'} ${r.first_name || ''} (@${r.username || '—'}) · ${new Date(r.created_at).toLocaleString('ru-RU')}`
  ).join('\n');
  await ctx.replyWithHTML(`⏳ <b>Ожидающие (${rows.length}):</b>\n\n${text}`);
});

bot.action('owner:csv', async (ctx) => {
  if (!ownerOnly(ctx)) return;
  await ctx.answerCbQuery('Готовлю CSV...');
  const data = db.prepare(`SELECT id,user_id,username,first_name,type,roles,status,created_at FROM applications ORDER BY created_at DESC LIMIT 500`).all();
  const header = 'id,user_id,username,first_name,type,roles,status,created_at\n';
  const csv = header + data.map(r =>
    [r.id, r.user_id, r.username || '', r.first_name || '', r.type, r.roles || '', r.status, r.created_at].join(',')
  ).join('\n');
  await ctx.replyWithDocument({ source: Buffer.from(csv, 'utf-8'), filename: `apps_${Date.now()}.csv` });
});

bot.action('owner:broadcast', async (ctx) => {
  if (!ownerOnly(ctx)) return;
  await ctx.answerCbQuery();
  pendingBroadcast.add(ctx.from.id);
  await ctx.reply('📢 Отправьте текст рассылки одним сообщением.\n/skip — отмена.');
});

/* ═══════════════ 6. EXPRESS + MINI APP ═══════════════ */
const app = express();
app.use(express.json({ limit: '2mb' }));

function verifyInitData(initData) {
  if (!initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (calc !== hash) return null;
    return JSON.parse(params.get('user'));
  } catch { return null; }
}

app.post('/api/submit', async (req, res) => {
  const { initData, ...payload } = req.body;
  const user = verifyInitData(initData) || { id: 0, first_name: 'Гость', username: null };
  if (payload.type === 'anketa' && user.id) {
    const rl = dbApi.checkRate(user.id);
    if (!rl.allowed) return res.status(429).json({ error: 'Rate limit', retryAfterMs: rl.retryAfterMs });
  }
  const appId = dbApi.save({
    userId: user.id, username: user.username, firstName: user.first_name,
    type: payload.type, roles: payload.roles, payload
  });
  try {
    await notifyModeration(appId, user, payload);
    if (payload.type === 'anketa' && user.id) dbApi.setRate(user.id);
    res.json({ ok: true, appId });
  } catch (e) {
    console.error('Telegram error:', e);
    res.status(500).json({ error: 'Telegram API error' });
  }
});

app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

/* ─── MINI APP (HTML) ─── */
const MINI_APP_HTML = `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<title>Тихий дождь — Анкета</title>
<script src="https://telegram.org/js/telegram-web-app.js"><\/script>
<style>
:root{--bg:#0e1116;--bg2:#161b22;--bg3:#1f2630;--bd:#2a313c;--tx:#e6edf3;--mut:#8b949e;--ac:#4f8cff;--dg:#f85149;--sc:#3fb950;--r:12px}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;padding:0;background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.5;min-height:100vh}
.app{max-width:640px;margin:0 auto;padding:16px 16px 100px}
.hd{display:flex;align-items:center;gap:10px;padding:8px 0 16px}
.lg{width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,#4f8cff,#6ea8fe);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.hd h1{font-size:17px;margin:0}.hd p{font-size:12px;color:var(--mut);margin:2px 0 0}
.tb{display:flex;gap:6px;background:var(--bg2);border:1px solid var(--bd);border-radius:var(--r);padding:5px;margin-bottom:18px}
.tab{flex:1;text-align:center;padding:10px 8px;border-radius:9px;font-size:14px;font-weight:600;color:var(--mut);cursor:pointer;user-select:none}
.tab.active{background:var(--ac);color:#fff}
.card{background:var(--bg2);border:1px solid var(--bd);border-radius:var(--r);padding:20px;margin-bottom:14px}
.card h2{font-size:15px;margin:0 0 14px;display:flex;align-items:center;gap:10px;font-weight:700}
.card h2 .n{background:var(--ac);color:#fff;width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}
.pw{position:sticky;top:0;z-index:10;background:var(--bg);padding:10px 0 12px;margin:-8px 0 12px}
.pb{height:6px;background:var(--bg3);border-radius:3px;overflow:hidden}
.pf{height:100%;width:0%;background:linear-gradient(90deg,#4f8cff,#6ea8fe);border-radius:3px;transition:width .3s}
.pt{font-size:12px;color:var(--mut);margin-top:6px;text-align:right}
.f{margin-bottom:18px}.f:last-child{margin-bottom:0}
.f label{display:block;font-size:14px;font-weight:600;margin-bottom:6px}
.f .h{display:block;font-size:12px;color:var(--mut);margin-bottom:8px;line-height:1.4}
.f input,.f textarea,.f select{width:100%;background:var(--bg3);border:1.5px solid var(--bd);border-radius:8px;padding:11px 12px;color:var(--tx);font-size:14px;font-family:inherit;outline:none;resize:vertical}
.f textarea{min-height:90px;line-height:1.5}
.f input:focus,.f textarea:focus,.f select:focus{border-color:var(--ac)}
.f.error input,.f.error textarea,.f.error select{border-color:var(--dg)}
.f .e{color:var(--dg);font-size:12px;margin-top:5px;display:none}
.f.error .e{display:block}
.rg{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ro{background:var(--bg3);border:2px solid var(--bd);border-radius:10px;padding:14px 10px;text-align:center;cursor:pointer;user-select:none;font-size:14px;font-weight:600}
.ro small{display:block;font-size:11px;color:var(--mut);font-weight:400;margin-top:4px}
.ro.sel{border-color:var(--ac);background:rgba(79,140,255,.12)}
.b{display:inline-flex;align-items:center;justify-content:center;width:100%;padding:13px 18px;border-radius:10px;border:none;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;user-select:none}
.b:active{transform:scale(.98)}
.b:disabled{opacity:.5}
.b1{background:var(--ac);color:#fff}
.b2{background:var(--bg3);color:var(--tx);border:1px solid var(--bd)}
.b3{background:var(--dg);color:#fff}
.br{display:flex;gap:10px;margin-top:16px}.br .b{flex:1}
.ts{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(150%);background:var(--bg3);border:1px solid var(--bd);color:var(--tx);padding:12px 18px;border-radius:10px;font-size:14px;max-width:90%;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.5);transition:transform .25s;z-index:1000;pointer-events:none}
.ts.show{transform:translateX(-50%) translateY(0)}
.ts.err{border-color:var(--dg);color:#ffb4b0}.ts.ok{border-color:var(--sc);color:#b6f0c0}
.succ{text-align:center;padding:40px 20px}
.si{width:72px;height:72px;border-radius:50%;background:rgba(63,185,80,.15);border:2px solid var(--sc);display:flex;align-items:center;justify-content:center;font-size:36px;color:var(--sc);margin:0 auto 20px}
.succ h2{font-size:20px;margin:0 0 10px}.succ p{color:var(--mut);font-size:14px;margin:0 0 24px}
.sum{border-bottom:1px solid var(--bd);padding:12px 0}.sum:last-child{border-bottom:none}
.sum .q{font-size:12px;color:var(--mut);margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.3px}
.sum .a{font-size:14px;white-space:pre-wrap;word-break:break-word}
.ss{font-size:13px;font-weight:700;color:var(--ac);text-transform:uppercase;letter-spacing:.5px;margin:18px 0 6px;border-bottom:2px solid var(--bd);padding-bottom:6px}
.ss:first-child{margin-top:0}
.hide{display:none!important}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-thumb{background:var(--bd);border-radius:3px}
@media(max-width:380px){.rg{grid-template-columns:1fr}.app{padding:12px 12px 100px}.card{padding:16px}}
</style></head><body>
<div class="app">
<div class="hd"><div class="lg">🌧</div><div><h1>Тихий дождь</h1><p>Анкета и жалобы</p></div></div>
<div class="tb">
<div class="tab active" data-tab="form">📝 Анкета</div>
<div class="tab" data-tab="complaint">🚨 Жалоба</div>
</div>
<div id="tab-form">
<div id="welcome" class="card">
<h2>🌧 Анкета в администрацию</h2>
<p style="color:var(--mut);font-size:14px;margin:0 0 14px">Здравствуйте! Это наша анкета для того, чтобы попасть в администрацию канала «Тихий дождь». Удачи!</p>
<div style="background:var(--bg3);border-radius:10px;padding:14px;font-size:13px;line-height:1.55;color:#c9d1d9;margin-bottom:16px;border-left:3px solid var(--dg)">
<strong style="color:var(--dg)">⚠️ ОБЯЗАТЕЛЬНО ПРОЧИТАТЬ</strong><br>
<span style="color:var(--dg);font-size:12px">ПРИ НЕ СОБЛЮДЕНИИ УСЛОВИЙ АНКЕТА НЕ БУДЕТ РАССМОТРЕНА!</span><br><br>
— Развёрнутые ответы (2–3 предложения минимум).<br><br>
— Короткие ответы не принимаются: «Да», «Нет», «Забыл», «Хз».<br><br>
— Шуточные анкеты не принимаются.<br><br>
Если отказ — спамить, флудить, угрожать бесполезно.
</div>
<button class="b b1" onclick="startForm()">Начать анкету →</button>
</div>
<div id="form" class="hide">
<div class="pw"><div class="pb"><div class="pf" id="pf"></div></div><div class="pt" id="pt">Шаг 1 из 3</div></div>
<div class="step" data-step="1"><div class="card"><h2><span class="n">1</span> Основная информация</h2>
<div class="f" data-f="age"><label>1. Сколько вам лет?</label><span class="h">Пример: мне 14 лет</span><input type="number" id="age" min="13" placeholder="Ваш возраст"/><div class="e">Минимум 13 лет</div></div>
<div class="f" data-f="nickname"><label>2. Ваш псевдоним (тег)</label><span class="h">Пример: #сатана, #скай. Без матов, 18+, оскорблений, -филии, нацизма, селфхарма.</span><input type="text" id="nickname" placeholder="#ваш_тег"/><div class="e">Псевдоним обязателен и без запрещённых слов</div></div>
<div class="f" data-f="gender"><label>3. Пол</label><select id="gender"><option value="">— Выберите —</option><option>Мужской</option><option>Женский</option></select><div class="e">Выберите пол</div></div>
<div class="f" data-f="timezone"><label>4. Часовой пояс (мск +0)</label><input type="text" id="timezone" placeholder="МСК+2"/><div class="e">Укажите часовой пояс</div></div>
<div class="f" data-f="role"><label>5. Должность</label><span class="h">Можно выбрать одну или обе</span>
<div class="rg"><div class="ro" data-role="Проверки" onclick="tgR(this)">🔍 Проверки<small>разбор проблем</small></div><div class="ro" data-role="Интервью" onclick="tgR(this)">🎤 Интервью<small>общение с владельцем</small></div></div>
<div class="e">Выберите хотя бы одну должность</div></div>
<div class="f" data-f="employment"><label>6. Занятость (минимум 2 часа)</label><input type="number" id="employment" min="2" placeholder="Часов в день"/><div class="e">Минимум 2 часа</div></div>
<div class="f" data-f="posts"><label>7. Постов в неделю (норма — 4)</label><input type="number" id="posts" min="4" placeholder="Постов в неделю"/><div class="e">Минимум 4 поста в неделю</div></div>
<div class="f" data-f="experience"><label>8. Опыт в должности</label><span class="h">Если есть — какой и где. Если нет — напишите «Нет опыта» и почему справитесь.</span><textarea id="experience" placeholder="Развёрнутый ответ"></textarea><div class="e">Минимум 2 предложения</div></div>
</div></div>
<div class="step hide" data-step="2"><div class="card"><h2><span class="n">2</span> Личные качества</h2>
<div class="f" data-f="burnout"><label>9. Как часто ловите выгорания?</label><textarea id="burnout"></textarea><div class="e">Минимум 2 предложения</div></div>
<div class="f" data-f="rest"><label>10. Как часто нужен рест? На сколько?</label><textarea id="rest"></textarea><div class="e">Минимум 2 предложения</div></div>
<div class="f" data-f="conflict"><label>11. Конфликтность (0/10)? Что вызывает агрессию?</label><textarea id="conflict"></textarea><div class="e">Минимум 2 предложения</div></div>
<div class="f" data-f="filter"><label>12. Умеете фильтровать речь?</label><textarea id="filter"></textarea><div class="e">Минимум 2 предложения</div></div>
<div class="f" data-f="deadlines"><label>13. Укладываетесь в дедлайны?</label><textarea id="deadlines"></textarea><div class="e">Минимум 2 предложения</div></div>
<div class="f" data-f="rules"><label>14. Соблюдаете правила и слушаетесь старших?</label><textarea id="rules"></textarea><div class="e">Минимум 2 предложения</div></div>
<div class="f" data-f="why"><label>15. Почему именно к нам? Что улучшите?</label><textarea id="why"></textarea><div class="e">Минимум 2 предложения</div></div>
<div class="f" data-f="confirm"><label>16. Подтверждаете норму и посты?</label><textarea id="confirm"></textarea><div class="e">Минимум 2 предложения</div></div>
</div></div>
<div class="step hide" data-step="3"><div class="card"><h2><span class="n">3</span> Ключевой этап</h2>
<p style="color:var(--mut);font-size:13px;margin:0 0 16px">Если идёте на Проверки и Интервью — отвечайте на оба блока.</p>
<div id="bc" class="hide"><div class="ss">🔍 Проверки</div>
<div class="f" data-f="ch1"><label>Пишете проблему для админа?</label><textarea id="ch1"></textarea><div class="e">Минимум 2 предложения</div></div>
<div class="f" data-f="ch2"><label>Умеете «вливаться в роль»?</label><textarea id="ch2"></textarea><div class="e">Минимум 2 предложения</div></div>
<div class="f" data-f="ch3"><label>Придумываете аргументы? Пример.</label><textarea id="ch3"></textarea><div class="e">Минимум 2 предложения</div></div>
<div class="f" data-f="ch4"><label>Располагаете админа к себе?</label><textarea id="ch4"></textarea><div class="e">Минимум 2 предложения</div></div>
<div class="f" data-f="ch5"><label>Формат постов? Обоснуйте.</label><textarea id="ch5"></textarea><div class="e">Минимум 2 предложения</div></div>
<div class="f" data-f="ch6"><label>Ведёте споры? Что при наездах?</label><textarea id="ch6"></textarea><div class="e">Минимум 2 предложения</div></div>
<div class="f" data-f="ch7"><label>Аргументируете позицию?</label><textarea id="ch7"></textarea><div class="e">Минимум 2 предложения</div></div>
<div class="f" data-f="ch8"><label>Пост: «Админ не отвечает 2 дня, пользователь злится» (3–5 предложений)</label><textarea id="ch8"></textarea><div class="e">Минимум 3 предложения</div></div>
<div class="f" data-f="ch9"><label>Исправите пост после ошибок?</label><textarea id="ch9"></textarea><div class="e">Минимум 2 предложения</div></div>
</div>
<div id="bi" class="hide"><div class="ss">🎤 Интервью</div>
<div class="f" data-f="in1"><label>Как быстро располагаете человека?</label><textarea id="in1"></textarea><div class="e">Минимум 2 предложения</div></div>
<div class="f" data-f="in2"><label>Какие вопросы раскрывают собеседника?</label><textarea id="in2"></textarea><div class="e">Минимум 2 предложения</div></div>
<div class="f" data-f="in3"><label>Что если ответы владельца короткие?</label><textarea id="in3"></textarea><div class="e">Минимум 2 предложения</div></div>
</div>
</div>
<div class="br"><button class="b b2" onclick="prevS()">← Назад</button><button class="b b1" onclick="toSum()">Проверить →</button></div>
</div>
<div class="br" id="nav12"><button class="b b2 hide" id="bp" onclick="prevS()">← Назад</button><button class="b b1" id="bn" onclick="nextS()">Далее →</button></div>
</div>
<div id="summary" class="hide"><div class="card"><h2>📋 Проверьте ответы</h2><div id="sumC"></div></div>
<div class="br"><button class="b b2" onclick="backF()">← Назад</button><button class="b b1" id="bs" onclick="send()">Отправить</button></div></div>
<div id="success" class="hide"><div class="succ"><div class="si">✓</div><h2>Анкета отправлена!</h2><p>Ожидайте ответа 24–72 часа.</p><button class="b b1" onclick="closeApp()">Закрыть</button></div></div>
</div>
<div id="tab-complaint" class="hide">
<div class="card" id="cform"><h2>🚨 Подать жалобу</h2>
<p style="color:var(--mut);font-size:13px;margin:0 0 16px">Опишите ситуацию. Ложные жалобы — бан.</p>
<div class="f" data-f="c-type"><label>Тип жалобы</label><select id="c-type"><option value="">— Выберите —</option><option>На администратора</option><option>На пользователя</option><option>На пост / контент</option><option>Другое</option></select><div class="e">Выберите тип</div></div>
<div class="f" data-f="c-nick"><label>Ник нарушителя</label><input type="text" id="c-nick" placeholder="@username"/><div class="e">Укажите нарушителя</div></div>
<div class="f" data-f="c-desc"><label>Описание (мин. 2 предложения)</label><textarea id="c-desc"></textarea><div class="e">Минимум 2 предложения</div></div>
<div class="f" data-f="c-proof"><label>Ссылки на доказательства</label><span class="h">Если нет — напишите «Нет»</span><textarea id="c-proof"></textarea><div class="e">Укажите доказательства или «Нет»</div></div>
<button class="b b3" onclick="sendC()">Отправить жалобу</button>
</div>
<div id="csuccess" class="hide"><div class="succ"><div class="si">✓</div><h2>Жалоба отправлена!</h2><p>Модераторы рассмотрят скоро.</p><button class="b b1" onclick="resetC()">Подать ещё</button></div></div>
</div>
</div>
<div class="ts" id="toast"></div>
<script>
const tg=window.Telegram?.WebApp;if(tg){try{tg.ready();tg.expand();tg.setHeaderColor('#0e1116');tg.setBackgroundColor('#0e1116')}catch(e){}}
const S={step:1,total:3,roles:[],data:{}};
const SK='td_v1';
const BW=['хуй','хуе','пизд','бляд','ебал','ебан','fuck','shit','сука','мраз','гандон','долбо','мудак','пидор','педик','секс','порно','18+','xxx','nude','nsfw','шлюх','дрян','проститут','нарко','героин','кокаин','амфетамин','спайс','закладк','алкогол','водк','пиво','виски','дебил','идиот','кретин','тупой','лох','чмо','урод','филия','нацист','фашист','гитлер','свастик','хайль','селфхарм','суицид','порез','расчлен'];
function toast(m,t){const e=document.getElementById('toast');e.textContent=m;e.className='ts show '+(t||'');clearTimeout(e._t);e._t=setTimeout(()=>e.classList.remove('show'),3000)}
function cnt(t){if(!t)return 0;const c=t.replace(/\b(т\.е|т\.д|т\.к)\./gi,'').replace(/\d+\.\d+/g,'');const m=c.match(/[.!?…]+/g);return m?m.length:(c.trim()?1:0)}
function badN(n){const l=n.toLowerCase().replace(/[^a-zа-яё0-9+]/gi,'');return BW.some(w=>l.includes(w))}
function setE(f,s){const e=document.querySelector('.f[data-f="'+f+'"]');if(e)e.classList.toggle('error',s)}
function clrE(){document.querySelectorAll('.f.error').forEach(f=>f.classList.remove('error'))}
function collect(){const ids=['age','nickname','gender','timezone','employment','posts','experience','burnout','rest','conflict','filter','deadlines','rules','why','confirm','ch1','ch2','ch3','ch4','ch5','ch6','ch7','ch8','ch9','in1','in2','in3'];const d={};ids.forEach(i=>{const e=document.getElementById(i);if(e)d[i]=e.value.trim()});return d}
function saveD(){try{localStorage.setItem(SK,JSON.stringify({data:collect(),roles:S.roles,step:S.step}))}catch(e){}}
function loadD(){try{const r=localStorage.getItem(SK);if(!r)return;const p=JSON.parse(r);if(p.data)Object.entries(p.data).forEach(([i,v])=>{const e=document.getElementById(i);if(e)e.value=v});if(p.roles){S.roles=p.roles;document.querySelectorAll('.ro').forEach(o=>o.classList.toggle('sel',S.roles.includes(o.dataset.role)))}if(p.step)S.step=p.step}catch(e){}}
function tgR(el){const r=el.dataset.role;el.classList.toggle('sel');if(S.roles.includes(r))S.roles=S.roles.filter(x=>x!==r);else S.roles.push(r);updR();saveD()}
function updR(){document.getElementById('bc').classList.toggle('hide',!S.roles.includes('Проверки'));document.getElementById('bi').classList.toggle('hide',!S.roles.includes('Интервью'))}
function startForm(){document.getElementById('welcome').classList.add('hide');document.getElementById('form').classList.remove('hide');loadD();updR();showS(S.step||1)}
function showS(n){S.step=n;document.querySelectorAll('.step').forEach(s=>s.classList.toggle('hide',+s.dataset.step!==n));document.getElementById('pf').style.width=(n/S.total*100)+'%';document.getElementById('pt').textContent='Шаг '+n+' из '+S.total;document.getElementById('nav12').classList.toggle('hide',n===3);document.getElementById('bp').classList.toggle('hide',n===1);window.scrollTo({top:0,behavior:'smooth'});saveD()}
function val(n){let ok=true;clrE();
if(n===1){const a=+document.getElementById('age').value;if(!a||a<13){setE('age',1);ok=false}
const nk=document.getElementById('nickname').value.trim();if(!nk||badN(nk)){setE('nickname',1);ok=false}
if(!document.getElementById('gender').value){setE('gender',1);ok=false}
if(!document.getElementById('timezone').value.trim()){setE('timezone',1);ok=false}
if(!S.roles.length){setE('role',1);ok=false}
const em=+document.getElementById('employment').value;if(!em||em<2){setE('employment',1);ok=false}
const p=+document.getElementById('posts').value;if(!p||p<4){setE('posts',1);ok=false}
if(cnt(document.getElementById('experience').value)<2){setE('experience',1);ok=false}}
if(n===2){['burnout','rest','conflict','filter','deadlines','rules','why','confirm'].forEach(f=>{if(cnt(document.getElementById(f).value)<2){setE(f,1);ok=false}})}
if(n===3){if(S.roles.includes('Проверки')){['ch1','ch2','ch3','ch4','ch5','ch6','ch7','ch9'].forEach(f=>{if(cnt(document.getElementById(f).value)<2){setE(f,1);ok=false}});if(cnt(document.getElementById('ch8').value)<3){setE('ch8',1);ok=false}}
if(S.roles.includes('Интервью')){['in1','in2','in3'].forEach(f=>{if(cnt(document.getElementById(f).value)<2){setE(f,1);ok=false}})}}
if(!ok)toast('Заполните все поля','err');return ok}
function nextS(){if(!val(S.step))return;if(S.step<S.total)showS(S.step+1)}
function prevS(){if(S.step>1)showS(S.step-1)}
function toSum(){if(!val(3))return;sum();document.getElementById('form').classList.add('hide');document.getElementById('summary').classList.remove('hide');window.scrollTo({top:0})}
function backF(){document.getElementById('summary').classList.add('hide');document.getElementById('form').classList.remove('hide');showS(3)}
const LB={age:'Возраст',nickname:'Псевдоним',gender:'Пол',timezone:'Часовой пояс',employment:'Занятость',posts:'Постов',experience:'Опыт',burnout:'Выгорания',rest:'Рест',conflict:'Конфликтность',filter:'Фильтр речи',deadlines:'Дедлайны',rules:'Правила',why:'Почему',confirm:'Подтверждение',ch1:'Проверки: проблема',ch2:'Проверки: роль',ch3:'Проверки: аргументы',ch4:'Проверки: расположить',ch5:'Проверки: формат',ch6:'Проверки: споры',ch7:'Проверки: аргумент',ch8:'Проверки: пробный пост',ch9:'Проверки: исправление',in1:'Интервью: расположить',in2:'Интервью: вопросы',in3:'Интервью: ответы'};
function esc(s){return String(s??'—').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function it(q,a){return'<div class="sum"><div class="q">'+esc(q)+'</div><div class="a">'+esc(a||'—')+'</div></div>'}
function sum(){const d=collect();let h='';h+='<div class="ss">Основная</div>';['age','nickname','gender','timezone','employment','posts','experience'].forEach(i=>h+=it(LB[i],d[i]));h+='<div class="ss">Должность</div>'+it('Выбрано',S.roles.join(' + '));h+='<div class="ss">Личные качества</div>';['burnout','rest','conflict','filter','deadlines','rules','why','confirm'].forEach(i=>h+=it(LB[i],d[i]));if(S.roles.includes('Проверки')){h+='<div class="ss">🔍 Проверки</div>';['ch1','ch2','ch3','ch4','ch5','ch6','ch7','ch8','ch9'].forEach(i=>h+=it(LB[i],d[i]))}if(S.roles.includes('Интервью')){h+='<div class="ss">🎤 Интервью</div>';['in1','in2','in3'].forEach(i=>h+=it(LB[i],d[i]))}document.getElementById('sumC').innerHTML=h}
function user(){const u=tg?.initDataUnsafe?.user;return u?{id:u.id,username:u.username,first_name:u.first_name,last_name:u.last_name}:{id:0,first_name:'Гость',username:null}}
async function api(p){const r=await fetch('/api/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...p,initData:tg?.initData||''})});if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}
async function send(){const b=document.getElementById('bs');b.disabled=true;b.textContent='Отправка...';const p={type:'anketa',roles:S.roles,data:collect(),user:user(),timestamp:new Date().toISOString()};try{await api(p);localStorage.removeItem(SK);document.getElementById('summary').classList.add('hide');document.getElementById('success').classList.remove('hide');window.scrollTo({top:0})}catch(e){console.error(e);toast('Ошибка отправки','err');b.disabled=false;b.textContent='Отправить'}}
async function sendC(){let ok=true;clrE();const t=document.getElementById('c-type').value,n=document.getElementById('c-nick').value.trim(),d=document.getElementById('c-desc').value.trim(),pr=document.getElementById('c-proof').value.trim();if(!t){setE('c-type',1);ok=false}if(!n){setE('c-nick',1);ok=false}if(cnt(d)<2){setE('c-desc',1);ok=false}if(!pr){setE('c-proof',1);ok=false}if(!ok){toast('Заполните поля','err');return}try{await api({type:'complaint',complaint:{type:t,nick:n,desc:d,proof:pr},user:user(),timestamp:new Date().toISOString()});document.getElementById('cform').classList.add('hide');document.getElementById('csuccess').classList.remove('hide')}catch(e){toast('Ошибка','err')}}
function resetC(){['c-type','c-nick','c-desc','c-proof'].forEach(i=>{const e=document.getElementById(i);if(e)e.value=''});clrE();document.getElementById('cform').classList.remove('hide');document.getElementById('csuccess').classList.add('hide')}
function closeApp(){if(tg)try{tg.close()}catch(e){location.reload()}else location.reload()}
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));t.classList.add('active');const g=t.dataset.tab;document.getElementById('tab-form').classList.toggle('hide',g!=='form');document.getElementById('tab-complaint').classList.toggle('hide',g!=='complaint');window.scrollTo({top:0,behavior:'smooth'})}));
document.addEventListener('input',e=>{if(e.target.closest('#form'))saveD()});
if(location.hash==='#complaint')setTimeout(()=>document.querySelector('.tab[data-tab="complaint"]')?.click(),100);
<\/script></body></html>`;

app.get('/', (_, res) => res.type('html').send(MINI_APP_HTML));
app.get('*', (_, res) => res.type('html').send(MINI_APP_HTML));

/* ═══════════════ 7. СТАРТ ═══════════════ */
app.listen(PORT, () => {
  console.log(`\n🌧 ═══════════════════════════════════════`);
  console.log(`   Сервер: ${PORT}`);
  console.log(`   Группа: ${CHAT_ID}`);
  console.log(`   Владелец: ${OWNER_ID}`);
  console.log(`🌧 ═══════════════════════════════════════\n`);
  bot.launch().then(() => console.log('🤖 Бот запущен')).catch(e => console.error('Bot error:', e));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
