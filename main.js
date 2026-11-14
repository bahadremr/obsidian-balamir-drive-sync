'use strict';
/*
 * BALAMİR Drive Sync — kişisel kullanım için Obsidian ↔ Google Drive iki yönlü eşitleme.
 *
 * - Giriş: Google "cihaz kodu" akışı (google.com/device). İzin kapsamı drive.file:
 *   eklenti Drive'da yalnız kendi oluşturduğu dosyaları görür.
 * - Eşitleme: üç yönlü karşılaştırma (yerel / Drive / son eşitleme durumu).
 *   İki tarafta da değişen dosyada hiçbir şey kaybolmaz: Drive sürümü "çakışma" kopyası olarak iner.
 * - Silmeler geri alınabilir: yerelde Obsidian .trash klasörüne, Drive'da çöp kutusuna gider.
 * - Hariç tutulan dosyalara (klasör, uzantı, boyut) hiç dokunulmaz.
 */
const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice, Modal, requestUrl, TFile, TFolder } = obsidian;

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEVICE_URL = 'https://oauth2.googleapis.com/device/code';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';

const DEFAULTS = {
  clientId: '',
  clientSecret: '',
  refreshToken: '',
  accountEmail: '',
  rootFolderName: 'BALAMİR (Obsidian)',
  rootFolderId: '',
  excludeFolders: 'tmp\noutput\n_work_portfolio2',
  excludeExtensions:
    'pln, pla, plt, bpn, tpl, mod, lcf, gsm, ifc, dwg, dxf, rvt, rfa, skp, 3dm, max, blend, fbx, obj, 3ds, ' +
    'pptx, ppt, psd, psb, ai, indd, mp4, mov, avi, mkv, zip, rar, 7z, exe, msi, pkl, pyc, bak, tmp',
  maxFileSizeMB: 10,
  autoSyncMinutes: 5,
  syncOnChange: true,
  maxLocalDeletes: 20,
  lastSync: 0,
  state: {},
};

const MIME_BY_EXT = {
  md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
  canvas: 'application/json', html: 'text/html', css: 'text/css', js: 'text/javascript',
  py: 'text/x-python', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// ---------- yardımcılar (saf fonksiyonlar, test edilebilir) ----------

function extOf(path) {
  const name = path.split('/').pop();
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function lines(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function buildFilter(s) {
  const folders = lines(s.excludeFolders).map((f) => f.replace(/^\/+|\/+$/g, '').toLowerCase());
  const exts = new Set(
    String(s.excludeExtensions || '').split(/[\s,;]+/).map((e) => e.replace(/^\./, '').toLowerCase()).filter(Boolean)
  );
  const max = (Number(s.maxFileSizeMB) || 0) * 1024 * 1024;
  return function included(path, size) {
    const lp = path.toLowerCase();
    if (folders.some((f) => lp === f || lp.startsWith(f + '/'))) return false;
    if (path.split('/').some((seg) => seg.startsWith('.'))) return false;
    if (exts.has(extOf(path))) return false;
    if (max && size != null && size > max) return false;
    return true;
  };
}

/**
 * L: Map(path -> {mtime, size})          yerel dosyalar
 * R: Map(path -> {id, ver, size})        Drive dosyaları (ver = md5 ya da değiştirilme zamanı)
 * S: {path -> {id, lmtime, lsize, rver}} son başarılı eşitlemedeki durum
 */
function computePlan(L, R, S, included) {
  const plan = [];
  const paths = new Set([...L.keys(), ...R.keys(), ...Object.keys(S)]);
  for (const p of [...paths].sort()) {
    const l = L.get(p), r = R.get(p), s = S[p];
    const size = l ? l.size : r ? r.size : null;
    if (!included(p, size)) {
      if (s) plan.push({ op: 'forget', path: p });
      continue;
    }
    const lc = s && l ? l.mtime !== s.lmtime || l.size !== s.lsize : true;
    const rc = s && r ? r.ver !== s.rver : true;
    if (l && r && s) {
      if (!lc && !rc) { if (s.id !== r.id) plan.push({ op: 'adopt', path: p }); }
      else if (lc && !rc) plan.push({ op: 'upload', path: p });
      else if (!lc && rc) plan.push({ op: 'download', path: p });
      else plan.push({ op: 'conflict', path: p });
    } else if (l && r && !s) {
      plan.push({ op: l.size === r.size ? 'adopt' : 'conflict', path: p });
    } else if (l && !r) {
      plan.push({ op: s && !lc ? 'deleteLocal' : 'upload', path: p });
    } else if (!l && r) {
      plan.push({ op: s && !rc ? 'deleteRemote' : 'download', path: p });
    } else if (s) {
      plan.push({ op: 'forget', path: p });
    }
  }
  return plan;
}

function conflictPath(path, date) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return `${dir}${base} (Drive çakışma ${stamp})${ext}`;
}

function form(obj) {
  return Object.entries(obj).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
}

function qstr(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function emailFromIdToken(idToken) {
  try {
    const part = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(part + '==='.slice((part.length + 3) % 4))));
    return JSON.parse(json).email || '';
  } catch (e) {
    return '';
  }
}

// ---------- Drive istemcisi ----------

class DriveClient {
  constructor(plugin) {
    this.plugin = plugin;
    this.accessToken = null;
    this.accessExp = 0;
  }

  get s() { return this.plugin.settings; }

  async token() {
    if (this.accessToken && Date.now() < this.accessExp - 60000) return this.accessToken;
    if (!this.s.refreshToken) throw new Error('Google hesabı bağlı değil. Ayarlardan "Bağlan"a bas.');
    const res = await requestUrl({
      url: TOKEN_URL, method: 'POST', contentType: 'application/x-www-form-urlencoded', throw: false,
      body: form({ client_id: this.s.clientId, client_secret: this.s.clientSecret, refresh_token: this.s.refreshToken, grant_type: 'refresh_token' }),
    });
    if (res.status !== 200) throw new Error('Google oturumu yenilenemedi (' + res.status + '). Ayarlardan yeniden bağlan.');
    const j = res.json;
    this.accessToken = j.access_token;
    this.accessExp = Date.now() + (j.expires_in || 3600) * 1000;
    return this.accessToken;
  }

  async call(method, url, opts = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const headers = { Authorization: 'Bearer ' + (await this.token()) };
      let body;
      if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
      else if (opts.raw !== undefined) { headers['Content-Type'] = opts.contentType; body = opts.raw; }
      const res = await requestUrl({ url, method, headers, body, throw: false });
      if (res.status === 401 && attempt === 0) { this.accessToken = null; continue; }
      if (res.status === 429 || res.status >= 500 || (res.status === 403 && /rate|quota/i.test(res.text || ''))) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      if (res.status >= 400) {
        const err = new Error('Drive hatası ' + res.status + ': ' + String(res.text || '').slice(0, 300));
        err.status = res.status;
        throw err;
      }
      if (opts.binary) return res.arrayBuffer;
      try { return res.json; } catch (e) { return null; }
    }
    throw new Error('Drive yanıt vermiyor, sonra tekrar denenecek.');
  }

  async findOrCreateRoot() {
    if (this.s.rootFolderId) {
      try {
        const f = await this.call('GET', `${DRIVE}/files/${this.s.rootFolderId}?fields=id,trashed`);
        if (f && !f.trashed) return { id: f.id, fresh: false };
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    const q = encodeURIComponent(`name='${qstr(this.s.rootFolderName)}' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`);
    const found = await this.call('GET', `${DRIVE}/files?q=${q}&fields=files(id)&spaces=drive`);
    let id = found.files && found.files[0] && found.files[0].id;
    if (!id) {
      const c = await this.call('POST', `${DRIVE}/files?fields=id`, { json: { name: this.s.rootFolderName, mimeType: FOLDER_MIME, parents: ['root'] } });
      id = c.id;
    }
    return { id, fresh: true };
  }

  async listTree(rootId) {
    const files = new Map();
    const folders = new Map([['', rootId]]);
    const queue = [['', rootId]];
    while (queue.length) {
      const [prefix, id] = queue.shift();
      let pageToken = '';
      do {
        const q = encodeURIComponent(`'${id}' in parents and trashed=false`);
        const res = await this.call('GET',
          `${DRIVE}/files?q=${q}&spaces=drive&pageSize=1000&fields=nextPageToken,files(id,name,mimeType,md5Checksum,modifiedTime,size)` +
          (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''));
        for (const f of res.files || []) {
          const p = prefix ? prefix + '/' + f.name : f.name;
          if (f.mimeType === FOLDER_MIME) {
            if (!folders.has(p)) { folders.set(p, f.id); queue.push([p, f.id]); }
          } else if (!String(f.mimeType || '').startsWith('application/vnd.google-apps.') && !files.has(p)) {
            files.set(p, { id: f.id, ver: f.md5Checksum || f.modifiedTime, size: f.size != null ? Number(f.size) : null });
          }
        }
        pageToken = res.nextPageToken || '';
      } while (pageToken);
    }
    return { files, folders };
  }

  async ensureFolder(folders, dir) {
    if (folders.has(dir)) return folders.get(dir);
    const slash = dir.lastIndexOf('/');
    const parentDir = slash >= 0 ? dir.slice(0, slash) : '';
    const parentId = await this.ensureFolder(folders, parentDir);
    const c = await this.call('POST', `${DRIVE}/files?fields=id`, { json: { name: dir.slice(slash + 1), mimeType: FOLDER_MIME, parents: [parentId] } });
    folders.set(dir, c.id);
    return c.id;
  }

  async upload(path, data, existingId, parentId) {
    const name = path.split('/').pop();
    const mime = MIME_BY_EXT[extOf(path)] || 'application/octet-stream';
    const meta = existingId ? {} : { name, parents: [parentId], mimeType: mime };
    const boundary = 'balamir' + Date.now().toString(16) + Math.random().toString(16).slice(2);
    const enc = new TextEncoder();
    const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`);
    const tail = enc.encode(`\r\n--${boundary}--`);
    const bytes = new Uint8Array(data);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);
    const fields = 'fields=id,md5Checksum,modifiedTime,size';
    const url = existingId ? `${UPLOAD}/files/${existingId}?uploadType=multipart&${fields}` : `${UPLOAD}/files?uploadType=multipart&${fields}`;
    const f = await this.call(existingId ? 'PATCH' : 'POST', url, { raw: body.buffer, contentType: `multipart/related; boundary=${boundary}` });
    return { id: f.id, ver: f.md5Checksum || f.modifiedTime, size: f.size != null ? Number(f.size) : bytes.length };
  }

  download(id) {
    return this.call('GET', `${DRIVE}/files/${id}?alt=media`, { binary: true });
  }

  trash(id) {
    return this.call('PATCH', `${DRIVE}/files/${id}?fields=id`, { json: { trashed: true } });
  }
}

// ---------- eşitleme ----------

class Syncer {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.drive = new DriveClient(plugin);
  }

  get s() { return this.plugin.settings; }

  localFiles() {
    const L = new Map();
    for (const f of this.app.vault.getFiles()) L.set(f.path, { mtime: f.stat.mtime, size: f.stat.size, file: f });
    return L;
  }

  async ensureLocalFolder(dir) {
    if (!dir) return;
    const existing = this.app.vault.getAbstractFileByPath(dir);
    if (existing instanceof TFolder) return;
    const slash = dir.lastIndexOf('/');
    if (slash > 0) await this.ensureLocalFolder(dir.slice(0, slash));
    try { await this.app.vault.createFolder(dir); } catch (e) { /* zaten var */ }
  }

  async writeLocal(path, data) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, data);
    } else {
      const slash = path.lastIndexOf('/');
      if (slash > 0) await this.ensureLocalFolder(path.slice(0, slash));
      await this.app.vault.createBinary(path, data);
    }
    const f = this.app.vault.getAbstractFileByPath(path);
    return { mtime: f.stat.mtime, size: f.stat.size };
  }

  async run({ allowManyDeletes = false, progress = () => {} } = {}) {
    const root = await this.drive.findOrCreateRoot();
    if (root.fresh || root.id !== this.s.rootFolderId) {
      // Yeni ya da değişmiş Drive klasörü: eski durum geçersiz, hiçbir şey silinmesin.
      this.s.rootFolderId = root.id;
      this.s.state = {};
    }
    const S = this.s.state;
    const { files: R, folders } = await this.drive.listTree(root.id);
    const L = this.localFiles();
    const plan = computePlan(L, R, S, buildFilter(this.s));

    const localDeletes = plan.filter((a) => a.op === 'deleteLocal').length;
    if (localDeletes > this.s.maxLocalDeletes && !allowManyDeletes) {
      throw new Error(
        `Bu eşitleme bilgisayardan ${localDeletes} dosya silecekti; güvenlik için durduruldu. ` +
        'Drive klasörünü bilerek temizlediysen "Silmelere izin vererek eşitle" komutunu çalıştır.'
      );
    }

    // Gerekli Drive klasörlerini sırayla oluştur (paralel işlerde çakışmasın).
    for (const a of plan) {
      if (a.op === 'upload' || a.op === 'conflict') {
        const slash = a.path.lastIndexOf('/');
        await this.drive.ensureFolder(folders, slash >= 0 ? a.path.slice(0, slash) : '');
      }
    }

    const counts = { upload: 0, download: 0, conflict: 0, deleteLocal: 0, deleteRemote: 0, errors: 0 };
    const errors = [];
    let done = 0;
    const work = plan.filter((a) => a.op !== 'adopt' && a.op !== 'forget');

    const doOne = async (a) => {
      const p = a.path, l = L.get(p), r = R.get(p);
      try {
        if (a.op === 'adopt') {
          S[p] = { id: r.id, lmtime: l.mtime, lsize: l.size, rver: r.ver };
        } else if (a.op === 'forget') {
          delete S[p];
        } else if (a.op === 'upload') {
          const data = await this.app.vault.readBinary(l.file);
          const slash = p.lastIndexOf('/');
          const up = await this.drive.upload(p, data, r && r.id, folders.get(slash >= 0 ? p.slice(0, slash) : ''));
          S[p] = { id: up.id, lmtime: l.mtime, lsize: l.size, rver: up.ver };
        } else if (a.op === 'download') {
          const data = await this.drive.download(r.id);
          const st = await this.writeLocal(p, data);
          S[p] = { id: r.id, lmtime: st.mtime, lsize: st.size, rver: r.ver };
        } else if (a.op === 'conflict') {
          // Drive sürümünü yan kopya olarak indir, yerel sürümü Drive'a yükle: iki sürüm de kalır.
          const remoteData = await this.drive.download(r.id);
          await this.writeLocal(conflictPath(p), remoteData);
          const data = await this.app.vault.readBinary(l.file);
          const slash = p.lastIndexOf('/');
          const up = await this.drive.upload(p, data, r.id, folders.get(slash >= 0 ? p.slice(0, slash) : ''));
          S[p] = { id: up.id, lmtime: l.mtime, lsize: l.size, rver: up.ver };
        } else if (a.op === 'deleteLocal') {
          await this.app.vault.trash(l.file, false);
          delete S[p];
        } else if (a.op === 'deleteRemote') {
          await this.drive.trash(r.id);
          delete S[p];
        }
        if (counts[a.op] !== undefined) counts[a.op]++;
      } catch (e) {
        counts.errors++;
        errors.push(p + ': ' + e.message);
        console.error('[BALAMİR Drive Sync]', p, e);
      }
      if (a.op !== 'adopt' && a.op !== 'forget') progress(++done, work.length);
    };

    for (const a of plan) if (a.op === 'adopt' || a.op === 'forget') await doOne(a);

    // 4 paralel işçi; her 25 işte bir durumu kaydet.
    let i = 0;
    const worker = async () => {
      while (i < work.length) {
        const a = work[i++];
        await doOne(a);
        if (done % 25 === 0) await this.plugin.saveSettings();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    this.s.lastSync = Date.now();
    await this.plugin.saveSettings();
    return { counts, errors };
  }
}

// ---------- arayüz ----------

class DeviceCodeModal extends Modal {
  constructor(app, info, onCancel) {
    super(app);
    this.info = info;
    this.onCancel = onCancel;
    this.finished = false;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Google hesabını bağla' });
    contentEl.createEl('p', { text: '1. Aşağıdaki kodu kopyala.' });
    const code = contentEl.createEl('div', { text: this.info.user_code });
    code.style.cssText = 'font-size:1.8em;font-weight:700;letter-spacing:.15em;text-align:center;margin:.5em 0;user-select:all;';
    contentEl.createEl('p', { text: '2. Açılan Google sayfasına kodu yapıştır, hesabını seç ve izin ver.' });
    contentEl.createEl('p', { text: '3. Bu pencere bağlantı tamamlanınca kendiliğinden kapanır.' });
    new Setting(contentEl).addButton((b) =>
      b.setButtonText('Kodu kopyala ve Google sayfasını aç').setCta().onClick(async () => {
        try { await navigator.clipboard.writeText(this.info.user_code); } catch (e) { /* yoksay */ }
        window.open(this.info.verification_url || 'https://www.google.com/device');
      })
    );
  }
  onClose() {
    this.contentEl.empty();
    if (!this.finished) this.onCancel();
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'BALAMİR Drive Sync' });

    containerEl.createEl('h3', { text: 'Google bağlantısı' });
    new Setting(containerEl).setName('OAuth istemci kimliği (Client ID)')
      .setDesc('Google Cloud\'da "TV ve sınırlı giriş cihazları" türünde oluşturulan istemci.')
      .addText((t) => t.setValue(s.clientId).onChange(async (v) => { s.clientId = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('OAuth istemci gizli anahtarı (Client secret)')
      .addText((t) => { t.inputEl.type = 'password'; t.setValue(s.clientSecret).onChange(async (v) => { s.clientSecret = v.trim(); await this.plugin.saveSettings(); }); });
    new Setting(containerEl)
      .setName(s.refreshToken ? 'Bağlı hesap: ' + (s.accountEmail || 'Google hesabı') : 'Bağlı değil')
      .addButton((b) => b.setButtonText(s.refreshToken ? 'Yeniden bağlan' : 'Bağlan').setCta().onClick(() => this.plugin.connect().then(() => this.display())))
      .addButton((b) => b.setButtonText('Bağlantıyı kes').setDisabled(!s.refreshToken).onClick(async () => {
        s.refreshToken = ''; s.accountEmail = ''; this.plugin.syncer.drive.accessToken = null;
        await this.plugin.saveSettings(); this.display();
      }));

    containerEl.createEl('h3', { text: 'Ne eşitlensin' });
    new Setting(containerEl).setName('Drive klasörünün adı')
      .setDesc('Drive\'ın ana dizininde bu adla bir klasör açılır. Değiştirirsen sonraki eşitleme yeni klasöre baştan yükler.')
      .addText((t) => t.setValue(s.rootFolderName).onChange(async (v) => {
        s.rootFolderName = v.trim() || DEFAULTS.rootFolderName; s.rootFolderId = ''; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName('Hariç klasörler').setDesc('Her satıra bir klasör (kasa köküne göre). Nokta ile başlayan klasörler zaten hariç.')
      .addTextArea((t) => { t.inputEl.rows = 5; t.setValue(s.excludeFolders).onChange(async (v) => { s.excludeFolders = v; await this.plugin.saveSettings(); }); });
    new Setting(containerEl).setName('Hariç uzantılar').setDesc('Bilgisayarda kalacak proje dosyası türleri, virgülle.')
      .addTextArea((t) => { t.inputEl.rows = 4; t.setValue(s.excludeExtensions).onChange(async (v) => { s.excludeExtensions = v; await this.plugin.saveSettings(); }); });
    new Setting(containerEl).setName('En büyük dosya (MB)').setDesc('Bundan büyük dosyalar bilgisayarda kalır. 0 = sınır yok.')
      .addText((t) => t.setValue(String(s.maxFileSizeMB)).onChange(async (v) => { s.maxFileSizeMB = Math.max(0, Number(v) || 0); await this.plugin.saveSettings(); }));

    containerEl.createEl('h3', { text: 'Ne zaman eşitlensin' });
    new Setting(containerEl).setName('Otomatik eşitleme aralığı (dakika)').setDesc('0 = kapalı. Obsidian açılınca da bir kez eşitlenir.')
      .addText((t) => t.setValue(String(s.autoSyncMinutes)).onChange(async (v) => {
        s.autoSyncMinutes = Math.max(0, Number(v) || 0); await this.plugin.saveSettings(); this.plugin.scheduleInterval();
      }));
    new Setting(containerEl).setName('Not değişince eşitle').setDesc('Son değişiklikten 1 dakika sonra eşitler.')
      .addToggle((t) => t.setValue(s.syncOnChange).onChange(async (v) => { s.syncOnChange = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName('Son eşitleme: ' + (s.lastSync ? new Date(s.lastSync).toLocaleString('tr-TR') : 'henüz yok'))
      .setDesc(Object.keys(s.state || {}).length + ' dosya eşitli.')
      .addButton((b) => b.setButtonText('Şimdi eşitle').setCta().onClick(() => this.plugin.sync().then(() => this.display())));
  }
}

module.exports = class BalamirDriveSync extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    if (!this.settings.state) this.settings.state = {};
    this.syncer = new Syncer(this);
    this.running = false;
    this.changeTimer = null;

    this.status = this.addStatusBarItem();
    this.setStatus(this.settings.lastSync ? 'Drive ✓' : 'Drive: bağlı değil');

    this.addRibbonIcon('refresh-cw', 'Drive ile eşitle', () => this.sync());
    this.addCommand({ id: 'sync-now', name: 'Drive ile şimdi eşitle', callback: () => this.sync() });
    this.addCommand({ id: 'sync-allow-deletes', name: 'Silmelere izin vererek eşitle', callback: () => this.sync({ allowManyDeletes: true }) });
    this.addCommand({ id: 'connect', name: 'Google hesabını bağla', callback: () => this.connect() });
    this.addSettingTab(new SettingsTab(this.app, this));

    const onChange = () => {
      if (this.running || !this.settings.syncOnChange || !this.settings.refreshToken) return;
      clearTimeout(this.changeTimer);
      this.changeTimer = setTimeout(() => this.sync({ quiet: true }), 60 * 1000);
    };
    this.app.workspace.onLayoutReady(() => {
      for (const ev of ['modify', 'create', 'delete', 'rename']) this.registerEvent(this.app.vault.on(ev, onChange));
      if (this.settings.refreshToken) setTimeout(() => this.sync({ quiet: true }), 5000);
    });
    this.scheduleInterval();
  }

  onunload() {
    clearTimeout(this.changeTimer);
    if (this.intervalId) window.clearInterval(this.intervalId);
  }

  scheduleInterval() {
    if (this.intervalId) window.clearInterval(this.intervalId);
    this.intervalId = null;
    const m = Number(this.settings.autoSyncMinutes) || 0;
    if (m > 0) {
      this.intervalId = window.setInterval(() => { if (this.settings.refreshToken) this.sync({ quiet: true }); }, m * 60 * 1000);
      this.registerInterval(this.intervalId);
    }
  }

  setStatus(text) {
    if (this.status) this.status.setText(text);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async connect() {
    const s = this.settings;
    if (!s.clientId || !s.clientSecret) {
      new Notice('Önce ayarlara Google OAuth istemci kimliği ve gizli anahtarını gir.');
      return;
    }
    const res = await requestUrl({
      url: DEVICE_URL, method: 'POST', contentType: 'application/x-www-form-urlencoded', throw: false,
      body: form({ client_id: s.clientId, scope: SCOPE }),
    });
    if (res.status !== 200) { new Notice('Google bağlantısı başlatılamadı: ' + String(res.text).slice(0, 200)); return; }
    const info = res.json;
    let cancelled = false;
    const modal = new DeviceCodeModal(this.app, info, () => { cancelled = true; });
    modal.open();
    let wait = (info.interval || 5) * 1000;
    const deadline = Date.now() + (info.expires_in || 1800) * 1000;
    while (!cancelled && Date.now() < deadline) {
      await sleep(wait);
      if (cancelled) break;
      const t = await requestUrl({
        url: TOKEN_URL, method: 'POST', contentType: 'application/x-www-form-urlencoded', throw: false,
        body: form({ client_id: s.clientId, client_secret: s.clientSecret, device_code: info.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      });
      let j = {};
      try { j = t.json; } catch (e) { /* yoksay */ }
      if (t.status === 200 && j.refresh_token) {
        s.refreshToken = j.refresh_token;
        s.accountEmail = emailFromIdToken(j.id_token || '');
        this.syncer.drive.accessToken = j.access_token;
        this.syncer.drive.accessExp = Date.now() + (j.expires_in || 3600) * 1000;
        await this.saveSettings();
        modal.finished = true;
        modal.close();
        new Notice('Google Drive bağlandı' + (s.accountEmail ? ': ' + s.accountEmail : '') + '. İlk eşitleme başlıyor.');
        this.sync();
        return;
      }
      if (j.error === 'authorization_pending') continue;
      if (j.error === 'slow_down') { wait += 5000; continue; }
      modal.finished = true;
      modal.close();
      new Notice('Google bağlantısı tamamlanamadı: ' + (j.error_description || j.error || t.status));
      return;
    }
    if (!cancelled) { modal.finished = true; modal.close(); new Notice('Kodun süresi doldu, yeniden "Bağlan"a bas.'); }
  }

  async sync(opts = {}) {
    if (this.running) { if (!opts.quiet) new Notice('Eşitleme zaten sürüyor.'); return; }
    if (!this.settings.refreshToken) { if (!opts.quiet) new Notice('Önce Google hesabını bağla (Ayarlar → BALAMİR Drive Sync).'); return; }
    this.running = true;
    clearTimeout(this.changeTimer);
    this.setStatus('Drive: eşitleniyor…');
    try {
      const { counts, errors } = await this.syncer.run({
        allowManyDeletes: !!opts.allowManyDeletes,
        progress: (d, n) => this.setStatus(`Drive: ${d}/${n}`),
      });
      const parts = [];
      if (counts.upload) parts.push(counts.upload + ' yüklendi');
      if (counts.download) parts.push(counts.download + ' indirildi');
      if (counts.conflict) parts.push(counts.conflict + ' çakışma (iki sürüm de saklandı)');
      if (counts.deleteLocal) parts.push(counts.deleteLocal + ' yerelde çöpe');
      if (counts.deleteRemote) parts.push(counts.deleteRemote + ' Drive\'da çöpe');
      if (errors.length) parts.push(errors.length + ' hata (konsola bak)');
      const time = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      this.setStatus((errors.length ? 'Drive ⚠ ' : 'Drive ✓ ') + time);
      if (parts.length && (!opts.quiet || counts.conflict || errors.length)) new Notice('Drive eşitleme: ' + parts.join(', '));
      else if (!opts.quiet) new Notice('Drive eşitleme: her şey güncel.');
    } catch (e) {
      console.error('[BALAMİR Drive Sync]', e);
      this.setStatus('Drive ⚠');
      new Notice('Drive eşitleme durdu: ' + e.message, 10000);
    } finally {
      this.running = false;
    }
  }
};

// Testler için saf fonksiyonlar
module.exports._internal = { buildFilter, computePlan, conflictPath, extOf, Syncer, DriveClient, DEFAULTS };
