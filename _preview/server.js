const path = require('path');
const fs = require('fs');
const express = require('express');
const swig = require('swig');
const nunjucks = require('nunjucks');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 4320;

const app = express();

// ---------- motor swig ----------
swig.setDefaults({ cache: false });
swig.setFilter('numberFractions', (v) => {
  const n = Number(v);
  if (isNaN(n)) return v;
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
});

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
function listTemplates() {
  const dir = path.join(ROOT, 'templates');
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
  const templates = listTemplates();
  const lang = req.query.lang || 'es';
  const langOptions = Object.keys(i18n)
    .map((l) => `<option value="${l}"${l === lang ? ' selected' : ''}>${l}</option>`)
    .join('');
  const items = templates
    .map((t) => {
      const label = t.replace(/\.html\.swig$|\.swig$|\.njk$/, '');
      return `<tr>
        <td><a href="/render?tpl=${encodeURIComponent(t)}" target="view">${t}</a></td>
        <td><a href="/swig?tpl=${encodeURIComponent(t)}" target="view">swig</a></td>
        <td><a href="/njk?tpl=${encodeURIComponent(t)}&lang=${encodeURIComponent(lang)}" target="view">nunjucks</a></td>
      </tr>`;
    })
    .join('\n');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Preview emails</title>
<style>
  body { font: 13px/1.4 -apple-system, "Segoe UI", sans-serif; display: flex; height: 100vh; margin: 0; }
  aside { width: 340px; overflow-y: auto; background: #1e2530; color: #cfd8e3; padding: 10px; }
  h1 { font-size: 14px; color: #fff; padding: 6px 4px 10px; }
  select { width: 100%; padding: 5px 8px; margin: 0 0 10px; background: #2c3646; color: #fff; border: 1px solid #3a4657; border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 3px 6px; border-bottom: 1px solid #2c3646; }
  a { color: #cfd8e3; text-decoration: none; }
  td a:first-child { font-weight: 600; }
  a:hover { color: #fff; }
  iframe { flex: 1; border: 0; background: #fff; }
</style></head><body>
<aside><h1>Preview emails</h1>
<select id="lang" title="Idioma">
  ${langOptions}
</select>
<table>${items}</table></aside>
<iframe name="view"></iframe>
<script>
  document.getElementById('lang').addEventListener('change', (e) => {
    location.search = '?lang=' + encodeURIComponent(e.target.value);
  });
</script>
</body></html>`);
});

// ---------- render con swig ----------
app.get('/swig', (req, res) => {
  const tpl = req.query.tpl || '';
  const abs = path.resolve(ROOT, tpl);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs)) return res.status(404).send('Plantilla no encontrada');
  try {
    res.type('html').send(swig.renderFile(abs, { ...ctx, SUBJECT: `[swig] ${path.basename(tpl)}` }));
  } catch (err) {
    res.status(500).send(`<pre style="color:#b00;font:13px monospace;padding:20px;white-space:pre-wrap">Error swig en ${tpl}\n\n${err.stack || err}</pre>`);
  }
});

// ---------- render con nunjucks ----------
app.get('/njk', (req, res) => {
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

app.listen(PORT, () => console.log(`Preview en http://localhost:${PORT}  (swig y nunjucks)`));