#!/usr/bin/env node
// أداة إرسال واتساب جماعي — تفتح واجهة في المتصفح.
//   تشغيل عادي:  node app.js
//   فحص ذاتي:    node app.js --test

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { exec } = require('child_process')

// على السيرفر: DATA_DIR يشير لقرص دائم عشان الجلسة ما تضيع مع كل إعادة تشغيل
const HERE = __dirname
const DATA = process.env.DATA_DIR || HERE
fs.mkdirSync(DATA, { recursive: true })
const SENT_LOG = path.join(DATA, 'sent.json')

// تصريح داخل الرابط: يفتح بضغطة بدون كلمة مرور، وما ينفتح لغير من عنده الرابط.
// محلياً بدون KEY = مفتوح (السيرفر على 127.0.0.1 فقط).
const HOSTED = !!process.env.PORT
const KEY = process.env.KEY || (HOSTED ? persistedKey() : null)
function persistedKey() {
  const f = path.join(DATA, 'key.txt')
  try { return fs.readFileSync(f, 'utf8').trim() } catch {}
  const k = crypto.randomBytes(12).toString('base64url')
  fs.writeFileSync(f, k)
  return k
}
const authed = url => !KEY || url.searchParams.get('k') === KEY

// ── تنظيف الأرقام (سعودي) ───────────────────────────────────────────────
function normalize(raw) {
  if (!raw) return null
  // الشيت فيه أحرف عرض صفري (zero-width) مدسوسة داخل الأرقام
  const digits = String(raw).replace(/[​-‏‪-‮﻿]/g, '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('00966')) return norm9(digits.slice(5))
  if (digits.startsWith('966')) return norm9(digits.slice(3))
  if (digits.startsWith('0')) return norm9(digits.slice(1))
  return norm9(digits)
}
const norm9 = d => (/^5\d{8}$/.test(d) ? '966' + d : null)

// ── قراءة CSV (يدعم الحقول بين علامات تنصيص) ────────────────────────────
function parseCSV(text) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false }
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}

// يحوّل أي رابط شيت إلى رابط تصدير CSV
function csvUrl(url) {
  const m = String(url).match(/\/spreadsheets\/d\/([\w-]+)/)
  if (!m) return url
  const gid = String(url).match(/[#&?]gid=(\d+)/)
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? '&gid=' + gid[1] : ''}`
}

async function loadContacts(sheet) {
  const res = await fetch(csvUrl(sheet))
  if (!res.ok) throw new Error(`تعذّر جلب الشيت (${res.status}) — تأكد أن المشاركة "أي شخص لديه الرابط"`)
  const rows = parseCSV(await res.text())
  if (rows.length < 2) throw new Error('الشيت فاضي')
  const ok = [], bad = [], seen = new Set()
  for (const [name, platform, contact] of rows.slice(1)) {
    if (!name?.trim()) continue
    const phone = normalize(contact)
    const row = { name: name.trim(), platform: (platform || '').trim(), contact: (contact || '').trim() }
    if (!phone) { bad.push(row); continue }
    if (seen.has(phone)) continue
    seen.add(phone)
    ok.push({ ...row, phone })
  }
  return { ok, bad }
}

const loadSent = () => { try { return JSON.parse(fs.readFileSync(SENT_LOG, 'utf8')) } catch { return [] } }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── حالة الجلسة ─────────────────────────────────────────────────────────
const state = { running: false, stop: false, client: null, clients: new Set() }

function push(type, data) {
  const msg = `data: ${JSON.stringify({ type, ...data })}\n\n`
  for (const res of state.clients) res.write(msg)
}

async function run({ contacts, message, minDelay, maxDelay }) {
  state.running = true
  state.stop = false
  const sent = new Set(loadSent())
  const pending = contacts.filter(c => !sent.has(c.phone))
  push('log', { level: 'info', text: `${pending.length} رسالة في الطابور` })

  try {
    if (!state.client) {
      const { Client, LocalAuth } = require('whatsapp-web.js')
      const QR = require('qrcode')
      const client = new Client({
        authStrategy: new LocalAuth({ dataPath: path.join(DATA, '.auth') }),
        puppeteer: {
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        },
      })
      client.on('qr', async qr => push('qr', { img: await QR.toDataURL(qr, { margin: 1, width: 260 }) }))
      client.on('disconnected', () => { state.client = null; push('log', { level: 'err', text: 'انقطع الاتصال بواتساب' }) })
      push('status', { text: 'يفتح واتساب...' })
      await new Promise((res, rej) => {
        client.once('ready', res)
        client.once('auth_failure', () => rej(new Error('فشل تسجيل الدخول')))
        client.initialize().catch(rej)
      })
      state.client = client
    }
    push('ready', {})

    const done = [...sent]
    let okCount = 0, failCount = 0
    for (const [i, c] of pending.entries()) {
      if (state.stop) { push('log', { level: 'info', text: 'تم الإيقاف' }); break }
      const id = `${c.phone}@c.us`
      try {
        if (!(await state.client.isRegisteredUser(id))) {
          failCount++
          push('row', { phone: c.phone, ok: false, name: c.name, why: 'ما عنده واتساب' })
        } else {
          await state.client.sendMessage(id, message.replaceAll('{name}', c.name))
          done.push(c.phone)
          fs.writeFileSync(SENT_LOG, JSON.stringify(done, null, 2)) // بعد كل رسالة، عشان الاستئناف
          okCount++
          push('row', { phone: c.phone, ok: true, name: c.name })
        }
      } catch (e) {
        failCount++
        push('row', { phone: c.phone, ok: false, name: c.name, why: e.message })
      }
      push('progress', { done: i + 1, total: pending.length, okCount, failCount })
      if (i < pending.length - 1 && !state.stop) {
        const wait = minDelay + Math.random() * Math.max(0, maxDelay - minDelay)
        push('waiting', { ms: Math.round(wait) })
        await sleep(wait)
      }
    }
    push('done', { okCount, failCount })
  } catch (e) {
    push('log', { level: 'err', text: e.message })
    push('done', { error: true })
  } finally {
    state.running = false
  }
}

// ── الخادم ──────────────────────────────────────────────────────────────
const body = req => new Promise(res => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => res(b ? JSON.parse(b) : {})) })
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  try {
    if (!authed(url)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('غير موجود') }
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(fs.readFileSync(path.join(HERE, 'ui.html')))
    }
    if (url.pathname === '/contacts') {
      const { ok, bad } = await loadContacts(url.searchParams.get('sheet'))
      return json(res, 200, { ok, bad, sent: loadSent(), running: state.running })
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write(': ok\n\n')
      state.clients.add(res)
      return req.on('close', () => state.clients.delete(res))
    }
    if (url.pathname === '/start' && req.method === 'POST') {
      if (state.running) return json(res, 409, { error: 'شغّال حالياً' })
      const b = await body(req)
      if (!b.message?.trim()) return json(res, 400, { error: 'اكتب الرسالة أولاً' })
      if (!b.contacts?.length) return json(res, 400, { error: 'ما فيه أرقام مختارة' })
      run(b)
      return json(res, 200, { started: true })
    }
    if (url.pathname === '/stop' && req.method === 'POST') { state.stop = true; return json(res, 200, {}) }
    if (url.pathname === '/reset' && req.method === 'POST') {
      try { fs.unlinkSync(SENT_LOG) } catch {}
      return json(res, 200, {})
    }
    res.writeHead(404).end()
  } catch (e) {
    json(res, 500, { error: e.message })
  }
})

function listen(port = +process.env.PORT || 3777) {
  server.once('error', e => (e.code === 'EADDRINUSE' && !HOSTED && port < 3790 ? listen(port + 1) : (console.error(e), process.exit(1))))
  server.listen(port, HOSTED ? '0.0.0.0' : '127.0.0.1', () => {
    if (HOSTED) return console.log(`شغّال على المنفذ ${port} · الرابط ينتهي بـ  /?k=${KEY}`)
    const url = `http://127.0.0.1:${port}`
    console.log(`\n  الأداة شغّالة:  ${url}\n  لا تسكّر هذي النافذة أثناء الإرسال.\n`)
    const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'
    exec(`${open} ${url}`)
  })
}

// ── فحص ذاتي ────────────────────────────────────────────────────────────
function test() {
  const a = require('assert')
  a.equal(normalize('533099252'), '966533099252')
  a.equal(normalize('54 399 5222'), '966543995222')
  a.equal(normalize(' 56 322 9975'), '966563229975')
  a.equal(normalize('5​08​88​75​77'), '966508887577')
  a.equal(normalize('0533099252'), '966533099252')
  a.equal(normalize('966533099252'), '966533099252')
  a.equal(normalize('00966533099252'), '966533099252')
  a.equal(normalize('+966 53 309 9252'), '966533099252')
  a.equal(normalize('alroub3.77@gmail.com'), null)
  a.equal(normalize('Member of @teamhydra.sa'), null)
  a.equal(normalize('433099252'), null)                 // ما يبدأ بـ5
  a.equal(normalize('5458493670'), null)                // ١٠ خانات = غلط
  a.equal(normalize(''), null)
  a.deepEqual(parseCSV('a,b\n"x\ny",z')[1], ['x\ny', 'z'])
  a.ok(csvUrl('https://docs.google.com/spreadsheets/d/ABC123/edit?usp=sharing').endsWith('/ABC123/export?format=csv'))
  a.ok(csvUrl('https://docs.google.com/spreadsheets/d/ABC/edit#gid=42').endsWith('format=csv&gid=42'))
  console.log('✓ الفحص نجح')
}

if (process.argv.includes('--test')) test()
else listen()
