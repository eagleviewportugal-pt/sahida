/**
 * SAHIDA — Motor de reservas (Google Apps Script)
 * ------------------------------------------------
 * Fluxo:
 *  1. O site envia o pedido (POST) → fica guardado na folha "Reservas".
 *  2. O cliente recebe logo: "Obrigado, entraremos em contacto para confirmar…"
 *  3. O restaurante recebe um email com o botão "Gerir reserva".
 *     Na página: Confirmar · Propor outro horário · Recusar.
 *  4. O cliente recebe a resposta. Se for uma proposta, tem um botão "Aceitar".
 *  5. Reservas confirmadas entram no Google Calendar (opcional).
 *
 * Os links abrem sempre uma página com um botão antes de fazer alguma coisa,
 * para que os filtros de segurança do email não confirmem reservas sozinhos.
 */

/* ================== CONFIGURAÇÃO ================== */
const CONFIG = {
  RESTAURANT_NAME: 'SAHIDA',
  OWNER_EMAIL: '__OWNER_EMAIL__',  // quem recebe os pedidos
  RESTAURANT_PHONE: '+351 968 808 075',
  SECRET: '__SECRET__',
  SHEET_ID: '1wZMJWVBoEHir7UTdXNAkyzTV2xY2jegtpAu0Tgger2c', // folha "Reservas SAHIDA"
  SHEET_NAME: 'Reservas',
  ADD_TO_CALENDAR: true,                  // cria evento no Calendar ao confirmar
  MEAL_DURATION_MIN: 120,
  MAX_PEOPLE: 12
};

const COLS = ['ID', 'Criado em', 'Estado', 'Nome', 'Email', 'Telefone', 'Data', 'Hora',
  'Pessoas', 'Observações', 'Idioma', 'Nova data', 'Nova hora', 'Nota do restaurante', 'Evento Calendar'];
const C = Object.fromEntries(COLS.map((c, i) => [c, i + 1])); // nome → nº coluna

const STATUS = {
  PENDING: 'Pendente', CONFIRMED: 'Confirmada', PROPOSED: 'Proposta enviada',
  DECLINED: 'Recusada', ACCEPTED: 'Confirmada (novo horário)'
};

/* ================== TEXTOS PARA O CLIENTE ================== */
const TXT = {
  pt: {
    recv_subj: 'Recebemos o seu pedido de reserva — {r}',
    recv_body: 'Olá {name},<br><br>Obrigado pelo seu pedido. <b>Entraremos em contacto para confirmar a sua reserva.</b>',
    conf_subj: 'Reserva confirmada — {r}',
    conf_body: 'Olá {name},<br><br>A sua reserva está <b>confirmada</b>. Até breve!',
    prop_subj: 'Proposta de novo horário — {r}',
    prop_body: 'Olá {name},<br><br>Infelizmente não temos disponibilidade no horário pedido. Podemos receber-vos em:',
    prop_btn: 'Aceitar este horário',
    prop_alt: 'Se não lhe der jeito, basta responder a este email ou ligar-nos.',
    decl_subj: 'O seu pedido de reserva — {r}',
    decl_body: 'Olá {name},<br><br>Lamentamos, mas não temos disponibilidade para o pedido abaixo. Esperamos recebê-lo noutra ocasião.',
    details: 'Detalhes', date: 'Data', time: 'Hora', people: 'Pessoas', notes: 'Observações', note_from: 'Nota do restaurante',
    footer: 'Para alterar ou cancelar, responda a este email ou ligue {phone}.',
    page_offer: 'Proposta de novo horário', page_accept_done: 'Reserva confirmada! Enviámos-lhe um email com os detalhes.',
    page_already: 'Este pedido já foi tratado. Se precisar de ajuda, ligue {phone}.'
  },
  en: {
    recv_subj: 'We received your booking request — {r}',
    recv_body: 'Hello {name},<br><br>Thank you for your request. <b>We will get in touch to confirm your booking.</b>',
    conf_subj: 'Booking confirmed — {r}',
    conf_body: 'Hello {name},<br><br>Your booking is <b>confirmed</b>. See you soon!',
    prop_subj: 'A new time for your booking — {r}',
    prop_body: 'Hello {name},<br><br>Unfortunately we have no availability at the time you asked for. We can welcome you at:',
    prop_btn: 'Accept this time',
    prop_alt: "If it doesn't suit you, just reply to this email or give us a call.",
    decl_subj: 'Your booking request — {r}',
    decl_body: "Hello {name},<br><br>We're sorry, but we have no availability for the request below. We hope to welcome you another time.",
    details: 'Details', date: 'Date', time: 'Time', people: 'Guests', notes: 'Notes', note_from: 'Note from the restaurant',
    footer: 'To change or cancel, reply to this email or call {phone}.',
    page_offer: 'Proposed new time', page_accept_done: "Booking confirmed! We've sent you an email with the details.",
    page_already: 'This request has already been handled. If you need help, call {phone}.'
  },
  es: {
    recv_subj: 'Hemos recibido su solicitud de reserva — {r}',
    recv_body: 'Hola {name},<br><br>Gracias por su solicitud. <b>Nos pondremos en contacto para confirmar su reserva.</b>',
    conf_subj: 'Reserva confirmada — {r}',
    conf_body: 'Hola {name},<br><br>Su reserva está <b>confirmada</b>. ¡Hasta pronto!',
    prop_subj: 'Propuesta de nuevo horario — {r}',
    prop_body: 'Hola {name},<br><br>Lamentablemente no tenemos disponibilidad a la hora solicitada. Podemos recibirles:',
    prop_btn: 'Aceptar este horario',
    prop_alt: 'Si no le viene bien, responda a este email o llámenos.',
    decl_subj: 'Su solicitud de reserva — {r}',
    decl_body: 'Hola {name},<br><br>Lo sentimos, pero no tenemos disponibilidad para la solicitud siguiente. Esperamos recibirle en otra ocasión.',
    details: 'Detalles', date: 'Fecha', time: 'Hora', people: 'Personas', notes: 'Observaciones', note_from: 'Nota del restaurante',
    footer: 'Para cambiar o cancelar, responda a este email o llame al {phone}.',
    page_offer: 'Propuesta de nuevo horario', page_accept_done: '¡Reserva confirmada! Le hemos enviado un email con los detalles.',
    page_already: 'Esta solicitud ya ha sido gestionada. Si necesita ayuda, llame al {phone}.'
  }
};

/* ================== ENTRADA: PEDIDO DO SITE ================== */
function doPost(e) {
  const p = (e && e.parameter) || {};
  if (p.website) return json({ ok: true }); // honeypot anti-spam

  const lang = TXT[p.lang] ? p.lang : 'pt';
  const r = {
    name: clean(p.name, 80), email: clean(p.email, 120), phone: clean(p.phone, 30),
    date: clean(p.date, 10), time: clean(p.time, 5), people: parseInt(p.people, 10),
    notes: clean(p.notes, 500), lang: lang
  };
  const valid = r.name && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email) && r.phone &&
    /^\d{4}-\d{2}-\d{2}$/.test(r.date) && /^\d{2}:\d{2}$/.test(r.time) &&
    r.people >= 1 && r.people <= CONFIG.MAX_PEOPLE;
  if (!valid) return json({ ok: false, error: 'invalid' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let id;
  try {
    id = Utilities.getUuid().split('-')[0].toUpperCase();
    sheet().appendRow([id, new Date(), STATUS.PENDING, r.name, r.email, "'" + r.phone,
      "'" + r.date, "'" + r.time, r.people, r.notes, lang, '', '', '', '']);
  } finally {
    lock.releaseLock();
  }

  // 1) Email automático ao cliente
  const tx = TXT[lang];
  sendToClient(r.email, fill(tx.recv_subj), fill(tx.recv_body, r) + detailsBox(r, lang), lang);

  // 2) Email ao restaurante
  const manage = url({ a: 'review', id: id, t: token('o', id) });
  MailApp.sendEmail({
    to: CONFIG.OWNER_EMAIL,
    replyTo: r.email,
    name: 'Reservas ' + CONFIG.RESTAURANT_NAME,
    subject: `Novo pedido: ${fmtDate(r.date)} ${r.time} · ${r.people} pax · ${r.name}`,
    htmlBody: wrapEmail(
      `<h2 style="margin:0 0 12px">Novo pedido de reserva</h2>` + detailsBox(r, 'pt') +
      `<p>Telefone: <a href="tel:${esc(r.phone)}">${esc(r.phone)}</a> · Email: ${esc(r.email)}</p>` +
      button(manage, 'Gerir reserva') +
      `<p style="color:#6f655b;font-size:13px">Na página pode confirmar, propor outro horário ou recusar. Pode também responder diretamente a este email para falar com o cliente.</p>`)
  });

  return json({ ok: true, id: id });
}

/* ================== PÁGINAS (links dos emails) ================== */
function doGet(e) {
  const p = (e && e.parameter) || {};
  const id = p.id || '';
  const found = id ? findRow(id) : null;
  if (!found) return page('Pedido não encontrado', '<p>Este link não é válido.</p>');
  const r = found.data, lang = TXT[r.lang] ? r.lang : 'pt', tx = TXT[lang];

  // ----- Lado do restaurante -----
  if (['review', 'confirm', 'propose', 'decline'].includes(p.a)) {
    if (p.t !== token('o', id)) return page('Acesso negado', '<p>Link inválido.</p>');

    if (p.a === 'review') return page('Reserva ' + id, ownerPage(r, id));
    if (r.status !== STATUS.PENDING) return page('Já tratada', `<p>Esta reserva já está: <b>${esc(r.status)}</b>.</p>`);
    if (p.go !== '1') return page('Reserva ' + id, ownerPage(r, id));

    if (p.a === 'confirm') {
      setCells(found.row, { 'Estado': STATUS.CONFIRMED, 'Nota do restaurante': clean(p.note, 300) });
      r.ownerNote = clean(p.note, 300);
      addToCalendar(found.row, r, r.date, r.time);
      sendToClient(r.email, fill(tx.conf_subj), fill(tx.conf_body, r) + detailsBox(r, lang) + noteBox(r.ownerNote, lang), lang);
      return page('Confirmada ✔', `<p>Reserva de <b>${esc(r.name)}</b> confirmada. O cliente já recebeu o email.</p>`);
    }

    if (p.a === 'propose') {
      const nd = clean(p.nd, 10), nt = clean(p.nt, 5);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nd) || !/^\d{2}:\d{2}$/.test(nt)) {
        return page('Falta informação', '<p>Indique a nova data e hora.</p>' + ownerPage(r, id));
      }
      const note = clean(p.note, 300);
      setCells(found.row, { 'Estado': STATUS.PROPOSED, 'Nova data': nd, 'Nova hora': nt, 'Nota do restaurante': note });
      const offer = url({ a: 'offer', id: id, t: token('c', id) });
      const proposed = Object.assign({}, r, { date: nd, time: nt });
      sendToClient(r.email, fill(tx.prop_subj),
        fill(tx.prop_body, r) + detailsBox(proposed, lang) + noteBox(note, lang) +
        button(offer, tx.prop_btn) + `<p>${tx.prop_alt}</p>`, lang);
      return page('Proposta enviada', `<p>Enviámos a proposta de <b>${fmtDate(nd)} às ${nt}</b> a ${esc(r.name)}. Vai receber um email quando o cliente aceitar.</p>`);
    }

    if (p.a === 'decline') {
      const note = clean(p.note, 300);
      setCells(found.row, { 'Estado': STATUS.DECLINED, 'Nota do restaurante': note });
      sendToClient(r.email, fill(tx.decl_subj), fill(tx.decl_body, r) + detailsBox(r, lang) + noteBox(note, lang), lang);
      return page('Recusada', `<p>O cliente foi informado.</p>`);
    }
  }

  // ----- Lado do cliente -----
  if (p.a === 'offer' || p.a === 'accept') {
    if (p.t !== token('c', id)) return page('—', '<p>Link inválido.</p>');
    if (r.status !== STATUS.PROPOSED) return page(CONFIG.RESTAURANT_NAME, `<p>${fill(tx.page_already)}</p>`);
    const proposed = Object.assign({}, r, { date: r.newDate, time: r.newTime });

    if (p.a === 'offer' || p.go !== '1') {
      return page(tx.page_offer, detailsBox(proposed, lang) + noteBox(r.ownerNote, lang) +
        `<form method="get" action="${url()}" target="_top">
           <input type="hidden" name="a" value="accept"><input type="hidden" name="id" value="${esc(id)}">
           <input type="hidden" name="t" value="${esc(p.t)}"><input type="hidden" name="go" value="1">
           <button class="b">${tx.prop_btn}</button></form><p>${tx.prop_alt}</p>`);
    }

    setCells(found.row, { 'Estado': STATUS.ACCEPTED, 'Data': r.newDate, 'Hora': r.newTime });
    addToCalendar(found.row, r, r.newDate, r.newTime);
    sendToClient(r.email, fill(tx.conf_subj), fill(tx.conf_body, r) + detailsBox(proposed, lang), lang);
    MailApp.sendEmail({
      to: CONFIG.OWNER_EMAIL, name: 'Reservas ' + CONFIG.RESTAURANT_NAME,
      subject: `✔ Aceite: ${fmtDate(r.newDate)} ${r.newTime} · ${r.people} pax · ${r.name}`,
      htmlBody: wrapEmail(`<p><b>${esc(r.name)}</b> aceitou o novo horário.</p>` + detailsBox(proposed, 'pt'))
    });
    return page(CONFIG.RESTAURANT_NAME, `<p>${tx.page_accept_done}</p>`);
  }

  return page(CONFIG.RESTAURANT_NAME, '<p>—</p>');
}

/* ================== PÁGINA DE GESTÃO (restaurante) ================== */
function ownerPage(r, id) {
  const t = token('o', id);
  const hidden = a => `<input type="hidden" name="a" value="${a}"><input type="hidden" name="id" value="${esc(id)}">
    <input type="hidden" name="t" value="${t}"><input type="hidden" name="go" value="1">`;
  const done = r.status !== STATUS.PENDING;
  return `<p>Estado: <b>${esc(r.status)}</b></p>` + detailsBox(r, 'pt') +
    `<p>📞 <a href="tel:${esc(r.phone)}">${esc(r.phone)}</a> · ✉️ ${esc(r.email)}</p>` +
    (done ? '' : `
    <form method="get" action="${url()}" target="_top" class="card">
      ${hidden('confirm')}
      <h3>Confirmar</h3>
      <label>Nota para o cliente (opcional)<input name="note" maxlength="300" placeholder="Ex.: mesa no pátio"></label>
      <button class="b">Confirmar reserva</button>
    </form>
    <form method="get" action="${url()}" target="_top" class="card">
      ${hidden('propose')}
      <h3>Propor outro horário</h3>
      <div class="row"><label>Data<input type="date" name="nd" value="${esc(r.date)}" required></label>
      <label>Hora<input type="time" name="nt" step="900" required></label></div>
      <label>Nota (opcional)<input name="note" maxlength="300" placeholder="Ex.: às 20h30 temos mesa no pátio"></label>
      <button class="b alt">Enviar proposta</button>
    </form>
    <form method="get" action="${url()}" target="_top" class="card">
      ${hidden('decline')}
      <h3>Recusar</h3>
      <label>Nota (opcional)<input name="note" maxlength="300"></label>
      <button class="b danger">Recusar pedido</button>
    </form>`);
}

/* ================== FOLHA ================== */
function sheet() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SHEET_NAME);
    sh.appendRow(COLS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, COLS.length).setFontWeight('bold');
  }
  return sh;
}

function findRow(id) {
  const sh = sheet();
  const last = sh.getLastRow();
  if (last < 2) return null;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues().map(v => String(v[0]));
  const i = ids.indexOf(String(id));
  if (i < 0) return null;
  const row = i + 2;
  const v = sh.getRange(row, 1, 1, COLS.length).getDisplayValues()[0];
  const get = n => v[C[n] - 1];
  return {
    row: row,
    data: {
      status: get('Estado'), name: get('Nome'), email: get('Email'), phone: String(get('Telefone')),
      date: asIso(get('Data')), time: asTime(get('Hora')), people: get('Pessoas'), notes: get('Observações'),
      lang: get('Idioma'), newDate: asIso(get('Nova data')), newTime: asTime(get('Nova hora')),
      ownerNote: get('Nota do restaurante')
    }
  };
}

function setCells(row, obj) {
  const sh = sheet();
  Object.keys(obj).forEach(k => {
    const v = obj[k];
    // texto, para o Sheets não converter datas/horas (evita 20:00 → 19:23)
    sh.getRange(row, C[k]).setValue(typeof v === 'string' && /^\d/.test(v) ? "'" + v : v);
  });
}

/* ================== CALENDAR ================== */
function addToCalendar(row, r, date, time) {
  if (!CONFIG.ADD_TO_CALENDAR) return;
  try {
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    const start = new Date(y, m - 1, d, hh, mm);
    const end = new Date(start.getTime() + CONFIG.MEAL_DURATION_MIN * 60000);
    const ev = CalendarApp.getDefaultCalendar().createEvent(
      `${r.people} pax · ${r.name}`, start, end,
      { description: `Tel: ${r.phone}\nEmail: ${r.email}\n${r.notes || ''}` });
    setCells(row, { 'Evento Calendar': ev.getId() });
  } catch (err) {
    console.error('Calendar: ' + err);
  }
}

/* ================== EMAIL / HTML ================== */
function sendToClient(to, subject, body, lang) {
  const tx = TXT[lang];
  MailApp.sendEmail({
    to: to, replyTo: CONFIG.OWNER_EMAIL, name: CONFIG.RESTAURANT_NAME, subject: subject,
    htmlBody: wrapEmail(body + `<p style="color:#6f655b;font-size:13px;margin-top:24px">${fill(tx.footer)}</p>`)
  });
}

function detailsBox(r, lang) {
  const tx = TXT[lang];
  return `<table style="border-collapse:collapse;margin:16px 0;background:#f6f1e9;border-radius:10px;width:100%;max-width:420px">
    <tr><td style="padding:10px 14px;color:#6f655b">${tx.date}</td><td style="padding:10px 14px"><b>${fmtDate(r.date)}</b></td></tr>
    <tr><td style="padding:10px 14px;color:#6f655b">${tx.time}</td><td style="padding:10px 14px"><b>${esc(r.time)}</b></td></tr>
    <tr><td style="padding:10px 14px;color:#6f655b">${tx.people}</td><td style="padding:10px 14px"><b>${esc(r.people)}</b></td></tr>
    ${r.notes ? `<tr><td style="padding:10px 14px;color:#6f655b">${tx.notes}</td><td style="padding:10px 14px">${esc(r.notes)}</td></tr>` : ''}
  </table>`;
}

function noteBox(note, lang) {
  return note ? `<p><i>${TXT[lang].note_from}:</i> ${esc(note)}</p>` : '';
}

function button(href, label) {
  return `<p style="margin:20px 0"><a href="${href}" style="background:#4a3324;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;display:inline-block">${esc(label)}</a></p>`;
}

function wrapEmail(inner) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#2a2622;max-width:560px;margin:auto;line-height:1.5">
    <p style="font-family:'DIN Alternate','Helvetica Neue',Arial,sans-serif;font-size:22px;letter-spacing:4px;font-weight:500;margin:0 0 16px">${esc(CONFIG.RESTAURANT_NAME)}</p>
    ${inner}</div>`;
}

function page(title, inner) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,Helvetica,sans-serif;background:#f6f1e9;color:#2a2622;margin:0;padding:24px}
    .w{max-width:520px;margin:auto} h1{font-family:Georgia,serif;font-weight:normal}
    .card{background:#fff;border:1px solid #e3d9ca;border-radius:12px;padding:16px;margin:14px 0}
    .card h3{margin:0 0 10px} label{display:block;font-size:13px;font-weight:bold;margin:8px 0}
    input{display:block;width:100%;box-sizing:border-box;padding:10px;border:1px solid #e3d9ca;border-radius:8px;font-size:16px;margin-top:4px}
    .row{display:flex;gap:10px}.row label{flex:1}
    .b{background:#4a3324;color:#fff;border:0;border-radius:999px;padding:12px 20px;font-size:15px;font-weight:bold;margin-top:10px;cursor:pointer}
    .b.alt{background:#a5623f}.b.danger{background:#9b3b2f}
  </style></head><body><div class="w"><p style="letter-spacing:4px;font-family:'DIN Alternate','Helvetica Neue',Arial,sans-serif;font-size:20px">${esc(CONFIG.RESTAURANT_NAME)}</p>
  <h1>${esc(title)}</h1>${inner}</div></body></html>`;
  return HtmlService.createHtmlOutput(html).setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ================== UTILITÁRIOS ================== */
function token(kind, id) {
  const sig = Utilities.computeHmacSha256Signature(kind + ':' + id, CONFIG.SECRET);
  return Utilities.base64EncodeWebSafe(sig).replace(/=+$/, '').slice(0, 22);
}

function url(params) {
  const base = ScriptApp.getService().getUrl();
  if (!params) return base;
  return base + '?' + Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
}

function fill(s, r) {
  return String(s).replace('{r}', CONFIG.RESTAURANT_NAME).replace('{phone}', CONFIG.RESTAURANT_PHONE)
    .replace('{name}', r ? esc(r.name) : '');
}

function clean(v, max) { return String(v || '').trim().slice(0, max); }

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function asIso(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const s = String(v || '').trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}` : s;
}

function asTime(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm');
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v || '').trim());
  return m ? m[1].padStart(2,'0') + ':' + m[2] : String(v || '');
}

function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : esc(iso);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* Executar UMA vez a partir do editor para autorizar Gmail, Folha e Calendar. */
function setup() {
  SpreadsheetApp.openById(CONFIG.SHEET_ID).rename('Reservas SAHIDA');
  sheet();
  CalendarApp.getDefaultCalendar();
  console.log('Folha pronta. Quota de emails restante hoje: ' + MailApp.getRemainingDailyQuota());
}
