/* bookmarks-to-html — parser/writer engine (no DOM dependency) */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BK = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const INTERNAL = /^(chrome|chrome-extension|chrome-untrusted|edge|bravesoftware|vivaldi|opera|about|moz-extension|place|safari|resource|view-source|webkit|ms-browser-extension):/i;

  function isInternal(u) {
    return INTERNAL.test(String(u || '').trim());
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escAttr(s) {
    return esc(s).replace(/[\u0000-\u001f\u007f]/g, '');
  }

  function cleanTitle(s) {
    return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /* ---------------- entity decoding ---------------- */

  const NAMED = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
    copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026',
    mdash: '\u2014', ndash: '\u2013', laquo: '\u00ab', raquo: '\u00bb',
    yen: '\u00a5', middot: '\u00b7', times: '\u00d7', divide: '\u00f7',
    deg: '\u00b0', plusmn: '\u00b1', frac12: '\u00bd', sect: '\u00a7',
    para: '\u00b6', dagger: '\u2020', bull: '\u2022', prime: '\u2032',
    Prime: '\u2033', euro: '\u20ac', pound: '\u00a3', cent: '\u00a2'
  };

  function decodeEntities(s) {
    return String(s == null ? '' : s).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g, function (m, body) {
      if (body[0] === '#') {
        const cp = body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return m;
        if (cp >= 0xd800 && cp <= 0xdfff) return m;
        try { return String.fromCodePoint(cp); } catch (e) { return m; }
      }
      const v = NAMED[body];
      return v === undefined ? m : v;
    });
  }

  /* ---------------- bytes -> string ---------------- */

  function decodeText(enc, u8, fatal) {
    return new TextDecoder(enc, fatal ? { fatal: true } : {}).decode(u8);
  }

  function decodeBytes(u8) {
    if (!u8 || !u8.length) return '';
    if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return decodeText('utf-8', u8.subarray(3));
    if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) return decodeText('utf-16le', u8.subarray(2));
    if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) return decodeText('utf-16be', u8.subarray(2));
    if (u8.length >= 2 && u8[0] === 0x7b && u8[1] === 0x00) return decodeText('utf-16le', u8);
    if (u8.length >= 2 && u8[0] === 0x00 && u8[1] === 0x7b) return decodeText('utf-16be', u8);
    try { return decodeText('utf-8', u8, true); } catch (e) { /* fall through */ }
    const cands = ['shift_jis', 'euc-jp', 'windows-1252'];
    for (let i = 0; i < cands.length; i++) {
      try {
        const s = decodeText(cands[i], u8, true);
        if (s.indexOf('\ufffd') === -1) return s;
      } catch (e) { /* next */ }
    }
    return decodeText('utf-8', u8);
  }

  /* ---------------- LZ4 (Firefox jsonlz4) ---------------- */

  function lz4Block(src, outLen) {
    const out = new Uint8Array(outLen);
    let i = 0, o = 0;
    while (i < src.length && o < outLen) {
      const token = src[i++];
      let lit = token >> 4;
      if (lit === 15) { let b; do { b = src[i++]; lit += b; } while (b === 255 && i < src.length); }
      for (let k = 0; k < lit && i < src.length; k++) out[o++] = src[i++];
      if (i + 1 >= src.length || o >= outLen) break;
      const off = src[i] | (src[i + 1] << 8);
      i += 2;
      let ml = token & 15;
      if (ml === 15) { let b; do { b = src[i++]; ml += b; } while (b === 255 && i < src.length); }
      ml += 4;
      if (off === 0 || off > o) break;
      let p = o - off;
      for (let k = 0; k < ml && o < outLen; k++) out[o++] = out[p++];
    }
    return out;
  }

  function unlz4(u8) {
    if (u8.length < 12) throw new Error('LZ4データが短すぎます');
    const size = (u8[8] | (u8[9] << 8) | (u8[10] << 16) | (u8[11] << 24)) >>> 0;
    if (!size) throw new Error('LZ4データのサイズが不正です');
    return lz4Block(u8.subarray(12), size);
  }

  /* ---------------- binary plist ---------------- */

  function readBPlist(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const len = u8.byteLength;
    const t = len - 32;
    if (t < 8) throw new Error('plist が短すぎます');
    const offSize = u8[t + 6];
    const refSize = u8[t + 7];
    const numObjects = Number(dv.getBigUint64(t + 8));
    const topObject = Number(dv.getBigUint64(t + 16));
    const tableOff = Number(dv.getBigUint64(t + 24));
    if (!numObjects || numObjects > 5e6 || !offSize || !refSize) throw new Error('plist ヘッダが不正です');

    const offsets = new Array(numObjects);
    for (let i = 0; i < numObjects; i++) {
      let o = 0;
      const base = tableOff + i * offSize;
      for (let j = 0; j < offSize; j++) o = o * 256 + u8[base + j];
      offsets[i] = o;
    }

    function be(off, size) {
      let v = 0;
      for (let j = 0; j < size; j++) v = v * 256 + u8[off + j];
      return v;
    }

    function sint(off, size) {
      let v = 0n;
      for (let j = 0; j < size; j++) v = (v << 8n) | BigInt(u8[off + j]);
      return Number(BigInt.asIntN(size * 8, v));
    }

    function readLen(p) {
      const marker = u8[p];
      if ((marker >> 4) !== 0x1) throw new Error('plist の長さ情報が不正です');
      const size = 1 << (marker & 15);
      return { n: be(p + 1, size), p: p + 1 + size };
    }

    const cache = new Map();

    function obj(ref) {
      if (cache.has(ref)) return cache.get(ref);
      if (!(ref >= 0 && ref < numObjects)) return null;
      const off = offsets[ref];
      const marker = u8[off];
      const type = marker >> 4;
      const info = marker & 15;
      let res = null;

      switch (type) {
        case 0x0:
          res = info === 0x9 ? true : info === 0x8 ? false : null;
          break;
        case 0x1:
          res = sint(off + 1, 1 << info);
          break;
        case 0x2:
          res = (1 << info) === 4 ? dv.getFloat32(off + 1) : dv.getFloat64(off + 1);
          break;
        case 0x3:
          res = new Date((dv.getFloat64(off + 1) + 978307200) * 1000);
          break;
        case 0x4: {
          let n = info, p = off + 1;
          if (info === 15) { const r = readLen(p); n = r.n; p = r.p; }
          res = u8.slice(p, p + n);
          break;
        }
        case 0x5: {
          let n = info, p = off + 1;
          if (info === 15) { const r = readLen(p); n = r.n; p = r.p; }
          let s = '';
          for (let j = 0; j < n; j++) s += String.fromCharCode(u8[p + j]);
          res = s;
          break;
        }
        case 0x6: {
          let n = info, p = off + 1;
          if (info === 15) { const r = readLen(p); n = r.n; p = r.p; }
          let s = '';
          for (let j = 0; j < n; j++) s += String.fromCharCode((u8[p + j * 2] << 8) | u8[p + j * 2 + 1]);
          res = s;
          break;
        }
        case 0x8:
          res = be(off + 1, info + 1);
          break;
        case 0xA:
        case 0xC: {
          let n = info, p = off + 1;
          if (info === 15) { const r = readLen(p); n = r.n; p = r.p; }
          const arr = [];
          cache.set(ref, arr);
          for (let j = 0; j < n; j++) arr.push(obj(be(p + j * refSize, refSize)));
          res = arr;
          break;
        }
        case 0xD: {
          let n = info, p = off + 1;
          if (info === 15) { const r = readLen(p); n = r.n; p = r.p; }
          const o = {};
          cache.set(ref, o);
          const keys = [];
          for (let j = 0; j < n; j++) keys.push(obj(be(p + j * refSize, refSize)));
          for (let j = 0; j < n; j++) o[String(keys[j])] = obj(be(p + (n + j) * refSize, refSize));
          res = o;
          break;
        }
        default:
          res = null;
      }
      cache.set(ref, res);
      return res;
    }

    return obj(topObject);
  }

  function parsePlistXML(text) {
    const toks = [];
    const re = /<(\/?)([a-zA-Z]+)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[4] !== undefined) {
        if (m[4].trim()) toks.push({ k: 'text', v: m[4] });
      } else {
        const attrs = m[3] || '';
        toks.push({
          k: m[1] === '/' ? 'close' : 'open',
          name: m[2].toLowerCase(),
          self: m[1] !== '/' && /\/\s*$/.test(attrs)
        });
      }
    }

    let i = 0;

    function val() {
      while (i < toks.length) {
        const t = toks[i];
        if (t.k !== 'open') { i++; continue; }
        if (t.name === 'plist' || t.name === 'xml') { i++; continue; }
        i++;
        if (t.name === 'dict' || t.name === 'array') {
          const isDict = t.name === 'dict';
          const acc = isDict ? {} : [];
          if (t.self) return acc;
          while (i < toks.length) {
            const c = toks[i];
            if (c.k === 'close' && c.name === t.name) { i++; break; }
            if (isDict) {
              if (c.k === 'open' && c.name === 'key') {
                i++;
                let key = '';
                if (toks[i] && toks[i].k === 'text') { key = toks[i].v; i++; }
                if (toks[i] && toks[i].k === 'close') i++;
                acc[decodeEntities(key).trim()] = val();
                continue;
              }
              i++;
            } else {
              acc.push(val());
            }
          }
          return acc;
        }
        if (t.name === 'true') return true;
        if (t.name === 'false') return false;
        if (t.self) return t.name === 'string' ? '' : null;
        let txt = '';
        while (i < toks.length && !(toks[i].k === 'close' && toks[i].name === t.name)) {
          if (toks[i].k === 'text') txt += toks[i].v;
          i++;
        }
        i++;
        if (t.name === 'integer' || t.name === 'real') return Number(txt.trim());
        if (t.name === 'date') return new Date(txt.trim());
        return decodeEntities(txt);
      }
      return null;
    }

    return val();
  }

  function getAttr(attrs, name) {
    const re = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
    const m = re.exec(attrs || '');
    if (!m) return '';
    return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] || '';
  }

  function num(v) {
    const n = parseInt(String(v || ''), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /* ---------------- parsers ---------------- */

  function fromChromium(node) {
    if (!node) return [];
    const kids = [];
    for (let i = 0; i < (node.children || []).length; i++) kids.push.apply(kids, fromChromium(node.children[i]));
    if (node.type === 'url' || (!node.children && node.url)) {
      const u = String(node.url || '').trim();
      if (!u) return kids;
      return [{ t: 'l', n: cleanTitle(node.name) || u, u: u, d: chromiumDate(node.date_added) }];
    }
    const name = cleanTitle(node.name);
    if (!name && !kids.length) return [];
    if (!name) return kids;
    return [{ t: 'f', n: name, c: kids }];
  }

  function chromiumDate(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const sec = Math.round(n / 1e6 - 11644473600);
    return sec > 0 ? sec : 0;
  }

  function fromFirefox(items) {
    const out = [];
    for (let i = 0; i < (items || []).length; i++) {
      const it = items[i];
      if (!it) continue;
      const ty = it.type || '';
      if (ty === 'text/x-moz-place-separator') continue;
      if (ty === 'text/x-moz-place-container' || (!ty && it.children)) {
        const kids = fromFirefox(it.children);
        const name = cleanTitle(it.title);
        if (!name) { out.push.apply(out, kids); continue; }
        out.push({ t: 'f', n: name, c: kids });
        continue;
      }
      const u = String(it.uri || '').trim();
      if (!u) continue;
      out.push({
        t: 'l',
        n: cleanTitle(it.title) || u,
        u: u,
        d: it.dateAdded ? Math.floor(Number(it.dateAdded) / 1e6) || 0 : 0
      });
    }
    return out;
  }

  function safariDate(v) {
    if (v instanceof Date) return v.getTime() > 0 ? Math.round(v.getTime() / 1000) : 0;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round(n + 978307200);
  }

  function fromSafari(items) {
    const out = [];
    for (let i = 0; i < (items || []).length; i++) {
      const it = items[i];
      if (!it || typeof it !== 'object') continue;
      const ty = it.WebBookmarkType;
      if (ty === 'WebBookmarkTypeList') {
        let name = cleanTitle(it.Title);
        if (name === 'com.apple.ReadingList') name = 'リーディングリスト';
        if (!name) name = '';
        const kids = fromSafari(it.Children);
        if (!name) { out.push.apply(out, kids); continue; }
        out.push({ t: 'f', n: name, c: kids });
        continue;
      }
      if (ty === 'WebBookmarkTypeLeaf') {
        const u = String(it.URLString || '').trim();
        if (!u) continue;
        const dict = it.URIDictionary || {};
        const title = cleanTitle(dict.title || it.Title || '');
        out.push({ t: 'l', n: title || u, u: u, d: safariDate(it.WebBookmarkDateCreated) });
      }
    }
    return out;
  }

  function parseNetscapeHTML(html) {
    const root = { t: 'f', n: '', c: [] };
    const stack = [{ arr: root.c }];
    let pending = null;
    let cap = null, capTag = '', capAttrs = '';

    const tagRe = /<(\/?)([a-zA-Z0-9]+)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    let prev = 0, m;

    while ((m = tagRe.exec(html)) !== null) {
      if (m.index > prev && cap !== null) cap += html.slice(prev, m.index);
      prev = tagRe.lastIndex;

      const close = m[1] === '/';
      const name = m[2].toLowerCase();
      const attrs = m[3] || '';

      if (!close && (name === 'a' || name === 'h3')) {
        cap = '';
        capTag = name;
        capAttrs = attrs;
        continue;
      }

      if (close && capTag === name) {
        const text = cleanTitle(decodeEntities(cap || ''));
        cap = null;
        capTag = '';
        if (name === 'h3') {
          pending = text || '(無題)';
          continue;
        }
        const raw = decodeEntities(getAttr(capAttrs, 'href')).trim();
        if (raw) {
          stack[stack.length - 1].arr.push({
            t: 'l',
            n: text || raw,
            u: raw,
            d: num(getAttr(capAttrs, 'add_date'))
          });
        }
        pending = null;
        continue;
      }

      if (name === 'dl') {
        if (!close) {
          if (pending !== null) {
            const f = { t: 'f', n: pending, c: [] };
            stack[stack.length - 1].arr.push(f);
            stack.push({ arr: f.c });
            pending = null;
          } else {
            stack.push({ arr: stack[stack.length - 1].arr });
          }
        } else if (stack.length > 1) {
          stack.pop();
        }
      }
    }
    return root.c;
  }

  function splitDelimited(text) {
    const head = text.slice(0, 4000).split(/\r?\n/)[0] || '';
    const cands = [',', '\t', ';'];
    let best = ',', bestN = -1;
    for (let i = 0; i < cands.length; i++) {
      const n = head.split(cands[i]).length;
      if (n > bestN) { bestN = n; best = cands[i]; }
    }
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += ch;
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === best) {
        row.push(field); field = '';
      } else if (ch === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else if (ch !== '\r') {
        field += ch;
      }
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
  }

  const URLCOL = ['url', 'uri', 'link', 'href', 'アドレス', 'リンク'];
  const TITLECOL = ['title', 'name', 'text', 'title/name', 'タイトル', '名前', '件名'];
  const FOLDERCOL = ['folder', 'folders', 'directory', 'group', 'collection', 'category', 'フォルダ', '分類'];
  const TAGCOL = ['tags', 'tag', 'タグ'];

  function pickCol(header, names) {
    for (let i = 0; i < header.length; i++) {
      const h = String(header[i] || '').trim().toLowerCase();
      for (let j = 0; j < names.length; j++) if (h === names[j]) return i;
    }
    return -1;
  }

  function parseDelimited(text) {
    const rows = splitDelimited(text);
    if (!rows.length) return [];
    const header = rows[0].map(function (c) { return String(c).trim(); });
    let uCol = pickCol(header, URLCOL);
    let tCol = pickCol(header, TITLECOL);
    let fCol = pickCol(header, FOLDERCOL);
    let gCol = pickCol(header, TAGCOL);
    let body = rows;

    if (uCol === -1) {
      uCol = -2;
      body = rows.slice(1);
      header.length = 0;
      tCol = fCol = gCol = -1;
    } else {
      body = rows.slice(1);
    }

    const root = { t: 'f', n: '', c: [] };
    const folders = new Map();

    function folderFor(path) {
      const parts = String(path || '').split(/[>\/\\|]+/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!parts.length) return root.c;
      let key = '';
      let arr = root.c;
      for (let i = 0; i < parts.length; i++) {
        key += '/' + parts[i];
        if (!folders.has(key)) {
          const f = { t: 'f', n: parts[i], c: [] };
          arr.push(f);
          folders.set(key, f.c);
        }
        arr = folders.get(key);
      }
      return arr;
    }

    for (let i = 0; i < body.length; i++) {
      const r = body[i];
      let u = '', t = '', f = '';
      if (uCol >= 0 && r[uCol]) {
        u = String(r[uCol]).trim();
        t = tCol >= 0 ? String(r[tCol] || '').trim() : '';
        f = fCol >= 0 ? String(r[fCol] || '').trim() : '';
        if (gCol >= 0 && !f) f = String(r[gCol] || '').trim();
      } else {
        for (let k = 0; k < r.length; k++) {
          if (/^(https?:|ftp:|mailto:|file:)/i.test(String(r[k] || '').trim())) { u = String(r[k]).trim(); break; }
        }
        if (!u) {
          for (let k = 0; k < r.length; k++) {
            const v = String(r[k] || '').trim();
            if (/^www\./i.test(v) && k < r.length) { u = 'http://' + v; break; }
          }
        }
        if (!u) continue;
        t = '';
        for (let k = 0; k < r.length; k++) {
          const v = String(r[k] || '').trim();
          if (v && v !== u) { t = v; break; }
        }
        f = header.length ? '' : '';
      }
      if (!u) continue;
      folderFor(f).push({ t: 'l', n: cleanTitle(t) || u, u: u, d: 0 });
    }
    return root.c;
  }

  function parseMarkdown(md) {
    const root = { t: 'f', n: '', c: [] };
    const stack = [{ level: 0, arr: root.c }];
    const lines = md.split(/\r?\n/);
    const linkRe = /\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim()) continue;

      const h = /^(#{1,6})\s+(.*)$/.exec(raw);
      if (h) {
        const level = h[1].length;
        const name = cleanTitle(h[2].replace(/[*_`]/g, ''));
        if (!name) continue;
        while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
        const f = { t: 'f', n: name, c: [] };
        stack[stack.length - 1].arr.push(f);
        stack.push({ level: level, arr: f.c });
        continue;
      }

      let found = false;
      let mm;
      linkRe.lastIndex = 0;
      while ((mm = linkRe.exec(raw)) !== null) {
        let u = mm[2].trim();
        if (u.charAt(0) === '<' && u.charAt(u.length - 1) === '>') u = u.slice(1, -1);
        if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) continue;
        stack[stack.length - 1].arr.push({
          t: 'l',
          n: cleanTitle(mm[1]) || u,
          u: u,
          d: 0
        });
        found = true;
      }
      if (found) continue;

      const bare = raw.match(/https?:\/\/[^\s<>"')\]]+/);
      if (bare) {
        const u = bare[0];
        const t = cleanTitle(raw.replace(u, '').replace(/^[\s\-*|•:]+|[\s\-*|•:]+$/g, ''));
        stack[stack.length - 1].arr.push({ t: 'l', n: t || u, u: u, d: 0 });
      }
    }
    return root.c;
  }

  function parseFlatText(text) {
    const out = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const m = line.match(/(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+|ftp:\/\/[^\s<>"']+)/);
      if (!m) continue;
      const u = m[1].replace(/[),.;]+$/, '');
      const t = cleanTitle(line.replace(m[1], '').replace(/^[\s\-*|•:]+|[\s|]+$/g, ''));
      out.push({ t: 'l', n: t || u, u: u, d: 0 });
    }
    return [{ t: 'f', n: '', c: out }].length ? out : out;
  }

  /* ---------------- format detection ---------------- */

  function detect(u8, name) {
    const lower = String(name || '').toLowerCase();
    if (u8 && u8.length >= 4 && u8[0] === 0x6d && u8[1] === 0x6f && u8[2] === 0x7a && u8[3] === 0x4c) return 'firefox-lz4';
    if (u8 && u8.length >= 6 && u8[0] === 0x62 && u8[1] === 0x70 && u8[2] === 0x6c && u8[3] === 0x69 && u8[4] === 0x73 && u8[5] === 0x74) return 'plist-binary';
    if (/\.jsonlz4$/.test(lower)) return 'firefox-lz4';
    if (/\.plist$/.test(lower)) return 'plist';
    if (/\.csv$/.test(lower)) return 'csv';
    if (/\.tsv$/.test(lower)) return 'tsv';
    if (/\.(md|markdown)$/.test(lower)) return 'markdown';
    return 'auto';
  }

  function sniffText(text) {
    const head = text.slice(0, 4096);
    if (/NETSCAPE-Bookmark-file/i.test(head)) return 'netscape';
    if (/^\s*[\[{]/.test(head)) return 'json';
    if (/<plist[\s>]/i.test(head) || /<!DOCTYPE plist/i.test(head)) return 'plist-xml';
    if (/<html[\s>]|<dl[\s>]|<a\s+href/i.test(head)) return 'html';
    const firstLine = head.split(/\r?\n/)[0] || '';
    if (firstLine.split('\t').length > 2) return 'tsv';
    if (firstLine.split(',').length > 2) return 'csv';
    if (/^#{1,6}\s|\[[^\]]*\]\([^)]*\)/m.test(head)) return 'markdown';
    return 'flat';
  }

  function parseBuffer(input, name) {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    const kind = detect(u8, name);
    const result = { format: '', nodes: [], meta: {} };

    if (kind === 'firefox-lz4') {
      result.format = 'Firefox (jsonlz4)';
      const json = JSON.parse(decodeText('utf-8', unlz4(u8)));
      result.nodes = fromFirefox(json.children || []);
      return result;
    }

    if (kind === 'plist-binary') {
      result.format = 'Safari (Bookmarks.plist)';
      const p = readBPlist(u8);
      result.nodes = fromSafari((p && p.Children) || (p ? [p] : []));
      return result;
    }

    const text = decodeBytes(u8);
    let sub = kind === 'auto' ? sniffText(text) : kind;
    if (kind === 'plist') {
      sub = /^\s*(<|bplist)/.test(text) ? (text.charAt(0) === '<' ? 'plist-xml' : 'plist-binary') : 'plist';
    }

    switch (sub) {
      case 'json': {
        const j = JSON.parse(text);
        if (j && j.roots) {
          result.format = 'Chrome / Edge / Brave';
          const order = ['bookmark_bar', 'other', 'synced'];
          const out = [];
          for (let i = 0; i < order.length; i++) out.push.apply(out, fromChromium(j.roots[order[i]]));
          result.nodes = out;
        } else {
          result.format = 'Firefox (JSON)';
          result.nodes = fromFirefox(j.children || (Array.isArray(j) ? j : []));
        }
        return result;
      }
      case 'firefox-lz4': {
        result.format = 'Firefox (jsonlz4)';
        const j = JSON.parse(decodeText('utf-8', unlz4(u8)));
        result.nodes = fromFirefox(j.children || []);
        return result;
      }
      case 'plist-xml': {
        result.format = 'Safari (Bookmarks.plist)';
        const obj = parsePlistXML(text);
        result.nodes = fromSafari((obj && obj.Children) || (obj ? [obj] : []));
        return result;
      }
      case 'netscape': {
        result.format = 'Netscape HTML';
        result.nodes = parseNetscapeHTML(text);
        return result;
      }
      case 'html': {
        result.format = 'HTML';
        result.nodes = parseNetscapeHTML(text);
        return result;
      }
      case 'csv': {
        result.format = 'CSV / TSV';
        result.nodes = parseDelimited(text);
        return result;
      }
      case 'tsv': {
        result.format = 'CSV / TSV';
        result.nodes = parseDelimited(text);
        return result;
      }
      case 'markdown': {
        result.format = 'Markdown';
        result.nodes = parseMarkdown(text);
        return result;
      }
      default: {
        result.format = /^\s*[\[{]/.test(text) ? 'JSON' : 'テキスト';
        result.nodes = parseFlatText(text);
        return result;
      }
    }
  }

  function plistNodeToJS(el) {
    if (!el) return null;
    const tag = el.tagName;
    if (tag === 'dict') {
      const o = {};
      const kids = el.children;
      for (let i = 0; i + 1 < kids.length; i += 2) {
        if (kids[i].tagName !== 'key') continue;
        o[kids[i].textContent] = plistNodeToJS(kids[i + 1]);
      }
      return o;
    }
    if (tag === 'array') {
      const a = [];
      for (let i = 0; i < el.children.length; i++) a.push(plistNodeToJS(el.children[i]));
      return a;
    }
    if (tag === 'true') return true;
    if (tag === 'false') return false;
    if (tag === 'integer' || tag === 'real') return Number(el.textContent);
    if (tag === 'date') return new Date(el.textContent);
    if (tag === 'string') return el.textContent;
    if (tag === 'data') return el.textContent;
    return el.textContent;
  }

  /* ---------------- tree utilities ---------------- */

  function count(nodes) {
    let links = 0, folders = 0;
    (function walk(list) {
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        if (n.t === 'f') { folders++; walk(n.c); } else links++;
      }
    })(nodes);
    return { links: links, folders: folders };
  }

  function prune(nodes, opts) {
    const out = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.t === 'f') {
        const kids = prune(n.c, opts);
        if (opts.dropEmpty && !kids.length) continue;
        out.push({ t: 'f', n: n.n, c: kids });
      } else if (n.t === 'l') {
        if (!n.u) continue;
        if (isInternal(n.u)) continue;
        out.push(n);
      }
    }
    return out;
  }

  function dedupe(nodes, scope) {
    if (scope === 'none') return { nodes: nodes, removed: 0 };
    let removed = 0;
    const seen = new Set();
    (function walk(list, localSeen) {
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        if (n.t === 'f') {
          const inner = scope === 'global' ? seen : new Set();
          n.c = walk(n.c, inner);
          out.push(n);
        } else {
          const key = n.u;
          if (localSeen.has(key)) { removed++; continue; }
          localSeen.add(key);
          out.push(n);
        }
      }
      return out;
    })(nodes, seen);
    return { nodes: nodes, removed: removed };
  }

  function flatten(nodes) {
    const links = [];
    (function walk(list) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].t === 'f') walk(list[i].c);
        else links.push(list[i]);
      }
    })(nodes);
    return links;
  }

  /* ---------------- Netscape HTML writer ---------------- */

  function line(indent, s) {
    return new Array(indent + 1).join('    ') + s;
  }

  function out(list, depth, opts, res) {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.t === 'f') {
        res.push(line(depth, '<DT><H3>' + esc(n.n) + '</H3>'));
        res.push(line(depth, '<DL><p>'));
        out(n.c, depth + 1, opts, res);
        res.push(line(depth, '</DL><p>'));
      } else {
        let a = '<DT><A HREF="' + escAttr(n.u) + '"';
        if (opts.keepDates && n.d) {
          a += ' ADD_DATE="' + Math.round(n.d) + '"';
        }
        a += '>' + esc(n.n) + '</A>';
        res.push(line(depth, a));
      }
    }
  }

  function buildNetscape(nodes, options) {
    const opts = Object.assign({ wrap: '', keepDates: true, dropEmpty: true, dedupe: 'none' }, options || {});

    let tree = prune(nodes, opts);
    if (opts.dedupe && opts.dedupe !== 'none') tree = dedupe(tree, opts.dedupe).nodes;

    if (opts.wrap) tree = [{ t: 'f', n: opts.wrap, c: tree }];

    const res = [];
    res.push('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    res.push('<!-- This is an automatically generated file.');
    res.push('     It will be read and overwritten.');
    res.push('     DO NOT EDIT! -->');
    res.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">');
    res.push('<TITLE>Bookmarks</TITLE>');
    res.push('<H1>Bookmarks</H1>');
    res.push('<DL><p>');
    out(tree, 1, opts, res);
    res.push('</DL><p>');
    return res.join('\n') + '\n';
  }

  return {
    parseBuffer: parseBuffer,
    parseDelimited: parseDelimited,
    parseNetscapeHTML: parseNetscapeHTML,
    parseMarkdown: parseMarkdown,
    parseFlatText: parseFlatText,
    buildNetscape: buildNetscape,
    prune: prune,
    dedupe: dedupe,
    flatten: flatten,
    count: count,
    decodeBytes: decodeBytes,
    unlz4: unlz4,
    readBPlist: readBPlist,
    esc: esc,
    escAttr: escAttr,
    decodeEntities: decodeEntities,
    isInternal: isInternal
  };
});
