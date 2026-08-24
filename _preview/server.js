const path = require('path');
const fs = require('fs');
const express = require('express');
const nunjucks = require('nunjucks');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 4320;

const app = express();

// ---------- motor nunjucks ----------
// loader que resuelve extends/include como swig: primero relativo a la plantilla padre, luego desde ROOT
class SwigLikeLoader extends nunjucks.Loader {
  getSource(name, parentName) {
    const candidates = [];
    if (parentName) candidates.push(path.posix.normalize(path.posix.join(path.posix.dirname(parentName), name)));
    candidates.push(name);
    for (const c of candidates) {
      const abs = path.resolve(ROOT, c);
      if (abs.startsWith(ROOT) && fs.existsSync(abs)) {
        return { src: fs.readFileSync(abs, 'utf8'), path: abs, noCache: true };
      }
    }
    throw new Error(`template not found: ${name} (from ${parentName || 'root'})`);
  }
}

const env = new nunjucks.Environment(new SwigLikeLoader(), { autoescape: true });
env.addFilter('numberFractions', (v) => {
  const n = Number(v);
  if (isNaN(n)) return v;
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
});
env.addFilter('date', (v, fmt) => {
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return v;
  const pad = (n) => String(n).padStart(2, '0');
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return String(fmt)
    .replace(/Y/g, () => String(d.getFullYear()))
    .replace(/F/g, () => MONTHS[d.getMonth()])
    .replace(/m/g, () => pad(d.getMonth() + 1))
    .replace(/d/g, () => pad(d.getDate()))
    .replace(/H/g, () => pad(d.getHours()))
    .replace(/M/g, () => pad(d.getMinutes()));
});

// ---------- contexto dummy ----------
function parseLoose(text) {
  const clean = text
    .replace(/ObjectId\s*\(\s*"([^"]+)"\s*\)/g, '"$1"')
    .replace(/ISODate\s*\(\s*"([^"]+)"\s*\)/g, '"$1"');
  return JSON.parse(clean);
}


function enrichBooking(booking) {
  const roomCounts = { single: 0, double: 0, twin: 0, triple: 0, quad: 0 };
  if (!booking) return { roomCounts, paxes: [] };
  const paxBySlug = {};
  for (const p of booking.paxes || []) paxBySlug[p.slug] = p;
  for (const room of booking.rooms || []) {
    const type = String(room.name || '').toLowerCase();
    if (type in roomCounts) roomCounts[type] += 1;
    for (const slug of room.paxlist || []) {
      const pax = paxBySlug[slug];
      if (pax) pax.room = type;
    }
  }
  return { roomCounts, paxes: booking.paxes || [] };
}

function buildContext() {
  const dir = path.join(ROOT, 'datadummy');
  const ctx = {
    adjustForTimezone: (d) => d,
    pad: (n, w) => String(n).padStart(w, '0'),
    enrichBooking,
  };
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const data = parseLoose(fs.readFileSync(path.join(dir, file), 'utf8'));
      const base = file.replace(/\.json$/, '');
      if (!base.includes('.')) ctx[base] = data;
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const k of Object.keys(data)) if (!(k in ctx)) ctx[k] = data[k];
      }
    } catch (e) {
      console.log('  [datadummy] no se pudo parsear:', file, '-', e.message);
    }
  }
  return ctx;
}

// ---------- indice de plantillas ----------
const SECTIONS = ['admin', 'affiliate', 'dmc', 'whitelabel'];

function listTemplates(section) {
  const dir = path.join(ROOT, 'templates', section || '');
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(d, entry.name));
      else if (/\.(swig|njk)$/.test(entry.name)) out.push(path.relative(ROOT, path.join(d, entry.name)).replace(/\\/g, '/'));
    }
  })(dir);
  return out.sort();
}

const ctx = buildContext();

// ---------- i18n ----------
const i18n = {};
for (const file of fs.readdirSync(path.join(ROOT, 'i18n')).filter((f) => f.endsWith('.json'))) {
  i18n[file.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', file), 'utf8'));
}

function createT(lang) {
  const dict = i18n[lang] || {};
  const fallback = i18n.es || {};
  return (key, vars) => {
    const str = dict[key] ?? fallback[key] ?? key;
    return vars ? str.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '') : str;
  };
}

// ---------- pagina indice ----------
app.get('/', (req, res) => {
  const section = SECTIONS.includes(req.query.section) ? req.query.section : '';
  const lang = req.query.lang || 'es';
  const langOptions = Object.keys(i18n)
    .map((l) => `<option value="${l}"${l === lang ? ' selected' : ''}>${l}</option>`)
    .join('');
  const menu = ['', ...SECTIONS]
    .map((s) => {
      const label = s || 'todos';
      const active = s === section ? ' active' : '';
      return `<a class="cat${active}" href="?section=${encodeURIComponent(s)}&lang=${encodeURIComponent(lang)}">${label}</a>`;
    })
    .join('');
  const items = listTemplates(section)
    .map((t) => {
      const label = t.replace(/\.html\.swig$|\.swig$|\.njk$/, '');
      return `<tr>
        <td><a href="/render?tpl=${encodeURIComponent(t)}&lang=${encodeURIComponent(lang)}" target="view">${t}</a></td>
      </tr>`;
    })
    .join('\n');
  const html = fs
    .readFileSync(path.join(__dirname, 'index.html'), 'utf8')
    .replace('__LANG_OPTIONS__', langOptions)
    .replace('__MENU__', menu)
    .replace('__ITEMS__', items)
    .replace('__SECTION__', encodeURIComponent(section));
  res.send(html);
});

// ---------- render con nunjucks ----------
app.get('/render', (req, res) => {
  const tpl = req.query.tpl || '';
  const abs = path.resolve(ROOT, tpl);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs)) return res.status(404).send('Plantilla no encontrada');
  try {
    const lang = req.query.lang || 'es';
    const html = env.render(tpl, { ...ctx, lang, t: createT(lang), SUBJECT: `[nunjucks] ${path.basename(tpl)}` });
    res.type('html').send(html);
  } catch (err) {
    res.status(500).send(`<pre style="color:#b00;font:13px monospace;padding:20px;white-space:pre-wrap">Error nunjucks en ${tpl}\n\n${err.stack || err}</pre>`);
  }
});

app.listen(PORT, () => console.log(`Preview en http://localhost:${PORT}  (nunjucks)`));