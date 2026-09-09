/* ============ Ноготок — панель управления (данные хранятся на GitHub) ============ */

const CFG = window.SHOP_CONFIG;
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => new Intl.NumberFormat('ru-RU').format(Math.round(n || 0)) + ' ₽';
const TOKEN_KEY = 'nogotok_gh_token';      // старый формат: ключ лежал открытым
const LOCK_KEY  = 'nogotok_locked_key';    // ключ, закрытый кодом доступа
const TRY_KEY   = 'nogotok_pin_tries';
const MAX_TRIES = 10;
const SITE_URL = CFG.siteUrl || `https://${CFG.owner}.github.io/${CFG.repo}/`;

const A = { token: '', user: null, db: null, sha: '', tab: 'products', filter: { q:'', cat:'' }, busy: false };

const box = {
  get(){ try{ return JSON.parse(localStorage.getItem(LOCK_KEY) || 'null'); }catch(e){ return null; } },
  set(v){ try{ localStorage.setItem(LOCK_KEY, JSON.stringify(v)); }catch(e){} },
  drop(){ try{ localStorage.removeItem(LOCK_KEY); localStorage.removeItem(TRY_KEY); }catch(e){} },
  tries(){ return +(localStorage.getItem(TRY_KEY) || 0); },
  bump(n){ try{ localStorage.setItem(TRY_KEY, String(n)); }catch(e){} },
};

/* ---------------------------------------- код доступа закрывает ключ GitHub */
const ENC = new TextEncoder(), DEC = new TextDecoder();
const toB64 = b => btoa(String.fromCharCode(...new Uint8Array(b)));
const fromB64 = t => Uint8Array.from(atob(t), c => c.charCodeAt(0));

async function pinKey(pin, salt){
  const base = await crypto.subtle.importKey('raw', ENC.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', salt, iterations:250000, hash:'SHA-256' },
    base, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
}
async function lockToken(token, pin){
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await pinKey(pin, salt);
  const data = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, ENC.encode(token));
  return { v:1, salt:toB64(salt), iv:toB64(iv), data:toB64(data) };
}
async function unlockToken(saved, pin){
  const key = await pinKey(pin, fromB64(saved.salt));
  const out = await crypto.subtle.decrypt({ name:'AES-GCM', iv: fromB64(saved.iv) }, key, fromB64(saved.data));
  return DEC.decode(out);
}
const validPin = p => /^\d{4,12}$/.test(p);

try{ A.token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || ''; }catch(e){}

/* ------------------------------------------------------- работа с GitHub */
function b64encode(text){
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64){
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function gh(path, opts = {}){
  const res = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': 'Bearer ' + A.token,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  let data = null;
  try{ data = await res.json(); }catch(e){}
  if (res.status === 401){ logout(); throw new Error('Ключ доступа не принят. Войдите заново.'); }
  if (res.status === 403 && (data?.message || '').includes('rate limit')) throw new Error('GitHub временно ограничил запросы, попробуйте через минуту');
  if (!res.ok){
    const err = new Error(data?.message || `Ошибка GitHub (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const contentsPath = file => `/repos/${CFG.owner}/${CFG.repo}/contents/${file}`;

async function loadDb(){
  const j = await gh(contentsPath(CFG.dbPath) + `?ref=${CFG.branch}&t=${Date.now()}`);
  A.sha = j.sha;
  A.db = JSON.parse(b64decode(j.content));
  A.db.settings ||= {}; A.db.categories ||= []; A.db.products ||= [];
}

async function saveDb(message){
  if (A.busy) throw new Error('Дождитесь окончания предыдущего сохранения');
  A.busy = true;
  publishState('saving');
  const body = () => JSON.stringify({
    message: message + ' [сайт]',
    content: b64encode(JSON.stringify(A.db, null, 2)),
    sha: A.sha,
    branch: CFG.branch,
  });
  try{
    let res;
    try{
      res = await gh(contentsPath(CFG.dbPath), { method:'PUT', body: body() });
    }catch(e){
      if (e.status !== 409 && e.status !== 422) throw e;
      await loadDb();                       // кто-то сохранил параллельно — берём свежую версию
      throw new Error('Каталог изменился на сайте, данные перезагружены. Повторите правку.');
    }
    A.sha = res.content.sha;
    publishState('published');
  }finally{
    A.busy = false;
  }
}

async function uploadImage(file){
  if (file.size > 8 * 1024 * 1024) throw new Error('Файл больше 8 МБ: ' + file.name);
  const ext = (file.name.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0].toLowerCase();
  if (!['.jpg','.jpeg','.png','.webp','.gif','.avif'].includes(ext)) throw new Error('Подойдут JPG, PNG или WebP');
  const base64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('Не удалось прочитать файл'));
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.readAsDataURL(file);
  });
  const stamp = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `${CFG.uploadDir}/${stamp}-${rand}${ext}`;
  await gh(contentsPath(path), {
    method:'PUT',
    body: JSON.stringify({ message: 'Фото товара [сайт]', content: base64, branch: CFG.branch }),
  });
  return path;
}

/* ----------------------------------------------- статус публикации сайта */
function publishState(state){
  const bar = $('#publish');
  if (!bar) return;
  const map = {
    saving:    ['saving',    'Сохраняем на сайт…'],
    published: ['published', 'Сохранено. Сайт обновится в течение минуты.'],
    live:      ['live',      'Всё опубликовано, сайт обновлён.'],
    idle:      ['idle',      ''],
  };
  const [cls, text] = map[state] || map.idle;
  bar.className = 'publish ' + cls;
  bar.innerHTML = text
    ? `<span>${text}</span><a href="${SITE_URL}" target="_blank" rel="noopener">Открыть сайт ↗</a>`
    : '';
  if (state === 'published') watchBuild();
}

let buildTimer = null;
async function watchBuild(){
  clearTimeout(buildTimer);
  let tries = 0;
  const tick = async () => {
    tries++;
    try{
      const b = await gh(`/repos/${CFG.owner}/${CFG.repo}/pages/builds/latest?t=${Date.now()}`);
      if (b.status === 'built'){ publishState('live'); return; }
      if (b.status === 'errored'){ toast('GitHub не смог собрать сайт, проверьте вкладку Actions', true); return; }
    }catch(e){ return; }                     // нет прав на чтение статуса — просто молчим
    if (tries < 20) buildTimer = setTimeout(tick, 6000);
  };
  buildTimer = setTimeout(tick, 8000);
}

/* ---------------------------------------------------------------- мелочи */
function toast(text, bad){
  const t = $('#toast');
  t.textContent = text;
  t.style.background = bad ? 'var(--sale)' : 'var(--ink)';
  t.classList.add('show');
  clearTimeout(window.__t);
  window.__t = setTimeout(() => t.classList.remove('show'), 3200);
}

function logout(forget){
  try{ localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); }catch(e){}
  if (forget) box.drop();
  A.token = ''; A.db = null; A.user = null;
  $('#panel').classList.add('hidden');
  $('#login').classList.remove('hidden');
  pickLoginMode();
}

/* ------------------------------------------------------------------ вход */
function showLoginError(text){
  const err = $('#login-error');
  err.textContent = text;
  err.style.display = text ? 'block' : 'none';
}

function pickLoginMode(){
  const saved = box.get();
  $('#pin-block').classList.toggle('hidden', !saved);
  $('#key-block').classList.toggle('hidden', !!saved);
  (saved ? $('#pin') : $('#password')).focus();
}

$('#use-key').onclick = e => {
  e.preventDefault();
  $('#pin-block').classList.add('hidden');
  $('#key-block').classList.remove('hidden');
  showLoginError('');
  $('#password').focus();
};

$('#login-form').onsubmit = async e => {
  e.preventDefault();
  const byKey = !$('#key-block').classList.contains('hidden');
  const btn = e.submitter || $('#key-block button');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Проверяем…';
  showLoginError('');
  try{
    await (byKey ? loginWithKey() : loginWithPin());
  }catch(ex){
    A.token = '';
    showLoginError(ex.message);
  }finally{
    btn.disabled = false; btn.textContent = label;
  }
};

async function loginWithPin(){
  const pin = $('#pin').value.trim();
  const saved = box.get();
  if (!saved) { pickLoginMode(); throw new Error('Ключ на этом устройстве не сохранён'); }
  let token;
  try{
    token = await unlockToken(saved, pin);
  }catch(ex){
    const left = MAX_TRIES - (box.tries() + 1);
    box.bump(box.tries() + 1);
    if (left <= 0){
      box.drop(); pickLoginMode();
      throw new Error('Слишком много попыток. Сохранённый ключ удалён, войдите по ключу GitHub.');
    }
    throw new Error(`Неверный код. Осталось попыток: ${left}`);
  }
  A.token = token;
  await checkAccess();
  box.bump(0);
  $('#pin').value = '';
  await start();
}

async function loginWithKey(){
  const token = $('#password').value.trim();
  if (!token) throw new Error('Вставьте ключ доступа GitHub');
  const pin = $('#newpin').value.trim();
  const pin2 = $('#newpin2').value.trim();
  if (pin || pin2){
    if (pin !== pin2) throw new Error('Коды не совпадают');
    if (!validPin(pin)) throw new Error('Код должен состоять из цифр, от 4 до 12 знаков');
  }
  A.token = token;
  await checkAccess();
  if (pin){
    box.set(await lockToken(token, pin));
    box.bump(0);
    try{ localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); }catch(e){}
  }
  $('#password').value = ''; $('#newpin').value = ''; $('#newpin2').value = '';
  await start();
}

async function checkAccess(){
  A.user = await gh('/user');
  const repo = await gh(`/repos/${CFG.owner}/${CFG.repo}`);
  if (repo.permissions && repo.permissions.push === false)
    console.warn('Ключ выглядит как «только чтение» — сохранение может не пройти');
}

$('#help-link').onclick = e => {
  e.preventDefault();
  alert(
    'Как получить ключ доступа:\n\n' +
    '1. Зайдите на github.com под аккаунтом с доступом к ' + CFG.owner + '\n' +
    '2. Settings → Developer settings → Personal access tokens → Fine-grained tokens\n' +
    '3. Generate new token. Имя любое, срок — на год.\n' +
    '4. Resource owner → ' + CFG.owner + ', Repository access → Only select repositories → ' + CFG.repo + '\n' +
    '5. Permissions → Repository permissions → Contents: Read and write\n' +
    '6. Generate token и скопируйте строку, которая начинается на github_pat_\n\n' +
    'Ключ нужен один раз на устройство. Дальше вход по коду доступа.'
  );
};

$('#logout').onclick = e => { e.preventDefault(); logout(); };
$$('#nav button').forEach(b => b.onclick = () => { A.tab = b.dataset.tab; render(); });

async function start(){
  await loadDb();
  $('#login').classList.add('hidden');
  $('#panel').classList.remove('hidden');
  counters();
  render();
}

function counters(){
  $('#n-products').textContent = A.db.products.length;
  $('#n-categories').textContent = A.db.categories.length;
}

function render(){
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === A.tab));
  ({ products: viewProducts, categories: viewCategories, orders: viewOrders,
     settings: viewSettings, security: viewSecurity }[A.tab] || viewProducts)();
}

const catTitle = slug => (A.db.categories.find(c => c.slug === slug) || {}).title || '—';
const nextId = list => list.reduce((m, x) => Math.max(m, +x.id || 0), 0) + 1;

const TRANSLIT = {а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',
  о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
const slugify = t => ([...String(t||'').toLowerCase()].map(c => TRANSLIT[c] ?? c).join('')
  .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'item');

/* --------------------------------------------------------------- товары */
function viewProducts(){
  const { q, cat } = A.filter;
  let list = A.db.products.slice().sort((a,b) => b.id - a.id);
  if (cat) list = list.filter(p => p.category === cat);
  if (q) list = list.filter(p => (p.title+' '+(p.brand||'')+' '+(p.sku||'')).toLowerCase().includes(q.toLowerCase()));

  $('#view').innerHTML = `
    <div class="topline">
      <div><h1>Товары</h1><p>Всего ${A.db.products.length} позиций · показано ${list.length}</p></div>
      <div class="tools">
        <input class="inp" id="p-search" placeholder="Поиск по названию или артикулу" value="${esc(q)}" style="width:250px">
        <select class="inp" id="p-cat" style="width:210px">
          <option value="">Все категории</option>
          ${A.db.categories.map(c => `<option value="${esc(c.slug)}" ${cat===c.slug?'selected':''}>${esc(c.title)}</option>`).join('')}
        </select>
        <button class="btn" id="p-add">+ Добавить товар</button>
      </div>
    </div>

    ${list.length ? `<table class="table">
      <thead><tr><th>Товар</th><th>Категория</th><th>Цена</th><th>Наличие</th><th>Статус</th><th></th></tr></thead>
      <tbody>${list.map(p => `
        <tr>
          <td>
            <div class="cellname">
              <div class="thumb">${p.images && p.images[0] ? `<img src="${esc(p.images[0])}" onerror="this.replaceWith('ФОТО')">` : 'НЕТ ФОТО'}</div>
              <div><b>${esc(p.title)}</b><small>${esc(p.brand || '')}${p.sku ? ' · арт. '+esc(p.sku) : ''}</small></div>
            </div>
          </td>
          <td><span class="tag">${esc(catTitle(p.category))}</span></td>
          <td><b>${money(p.price)}</b>${p.oldPrice > p.price ? `<br><small style="color:var(--muted);text-decoration:line-through">${money(p.oldPrice)}</small>` : ''}</td>
          <td>${p.inStock ? '<span class="tag on">В наличии</span>' : '<span class="tag">Под заказ</span>'}</td>
          <td>${p.published !== false ? '<span class="tag on">На сайте</span>' : '<span class="tag off">Скрыт</span>'}
              ${p.badge ? `<span class="tag hit">${({hit:'Хит',new:'Новинка',sale:'Скидка'})[p.badge]||''}</span>` : ''}</td>
          <td><div class="acts">
            <button class="btn sm ghost" data-edit="${p.id}">Изменить</button>
            <button class="btn sm ghost" data-copy="${p.id}">Копия</button>
            <button class="btn sm danger" data-del="${p.id}">Удалить</button>
          </div></td>
        </tr>`).join('')}
      </tbody></table>`
    : `<div class="empty"><b>Товаров нет</b>Нажмите «Добавить товар», чтобы выложить первую позицию.</div>`}`;

  $('#p-add').onclick = () => editProduct(null);
  $('#p-cat').onchange = e => { A.filter.cat = e.target.value; viewProducts(); };
  let timer;
  $('#p-search').oninput = e => { clearTimeout(timer); timer = setTimeout(() => { A.filter.q = e.target.value; viewProducts(); }, 250); };
  $$('[data-edit]').forEach(b => b.onclick = () => editProduct(A.db.products.find(p => p.id == b.dataset.edit)));
  $$('[data-copy]').forEach(b => b.onclick = () => {
    const src = A.db.products.find(p => p.id == b.dataset.copy);
    editProduct({ ...src, id: null, title: src.title + ' (копия)' });
  });
  $$('[data-del]').forEach(b => b.onclick = async () => {
    const p = A.db.products.find(x => x.id == b.dataset.del);
    if (!confirm(`Удалить «${p.title}»? Товар пропадёт с сайта.`)) return;
    const backup = A.db.products.slice();
    A.db.products = A.db.products.filter(x => x.id != p.id);
    try{
      await saveDb('Удалён товар: ' + p.title);
      counters(); viewProducts(); toast('Товар удалён с сайта');
    }catch(e){ A.db.products = backup; toast(e.message, true); viewProducts(); }
  });
}

/* --------------------------------------------------- редактор товара */
function editProduct(p){
  const isNew = !p || !p.id;
  const d = p || { images: [], specs: [], inStock: true, published: true, unit: 'шт', price: 0, oldPrice: 0,
                   category: (A.db.categories[0] || {}).slug || '' };

  openSheet(`
    <h2>${isNew ? 'Новый товар' : 'Редактирование товара'}</h2>
    <form id="pf">
      <div class="f"><label class="lbl">Название *</label>
        <input class="inp" name="title" value="${esc(d.title||'')}" placeholder="Фрезер для маникюра Strong 210"></div>

      <div class="row3">
        <div class="f"><label class="lbl">Категория *</label>
          <select class="inp" name="category">
            ${A.db.categories.map(c => `<option value="${esc(c.slug)}" ${d.category===c.slug?'selected':''}>${esc(c.title)}</option>`).join('')}
          </select></div>
        <div class="f"><label class="lbl">Бренд</label>
          <input class="inp" name="brand" value="${esc(d.brand||'')}" placeholder="Strong"></div>
        <div class="f"><label class="lbl">Артикул</label>
          <input class="inp" name="sku" value="${esc(d.sku||'')}" placeholder="AP-001"></div>
      </div>

      <div class="row3">
        <div class="f"><label class="lbl">Цена, ₽ *</label>
          <input class="inp" name="price" type="number" min="0" step="1" value="${d.price||0}"></div>
        <div class="f"><label class="lbl">Старая цена, ₽</label>
          <input class="inp" name="oldPrice" type="number" min="0" step="1" value="${d.oldPrice||0}">
          <div class="hint">Больше цены — покажем скидку</div></div>
        <div class="f"><label class="lbl">Единица</label>
          <input class="inp" name="unit" value="${esc(d.unit||'шт')}" placeholder="шт / уп / набор"></div>
      </div>

      <div class="row3">
        <div class="f"><label class="lbl">Метка на карточке</label>
          <select class="inp" name="badge">
            <option value="" ${!d.badge?'selected':''}>Без метки</option>
            <option value="hit"  ${d.badge==='hit'?'selected':''}>Хит продаж</option>
            <option value="new"  ${d.badge==='new'?'selected':''}>Новинка</option>
            <option value="sale" ${d.badge==='sale'?'selected':''}>Скидка</option>
          </select></div>
        <div class="f" style="display:flex;align-items:flex-end">
          <label class="switch"><input type="checkbox" name="inStock" ${d.inStock!==false?'checked':''}> В наличии</label></div>
        <div class="f" style="display:flex;align-items:flex-end">
          <label class="switch"><input type="checkbox" name="published" ${d.published!==false?'checked':''}> Показывать на сайте</label></div>
      </div>

      <div class="f"><label class="lbl">Фотографии</label>
        <div class="imgs" id="imgs"></div>
        <input type="file" id="file" accept="image/*" multiple class="hidden">
        <div class="hint">До 8 фото, JPG/PNG/WebP, каждое до 8 МБ. Первое фото — главное в каталоге. Загрузка идёт сразу на сайт.</div>
      </div>

      <div class="f"><label class="lbl">Описание</label>
        <textarea class="inp" name="description" placeholder="Из чего состоит, для кого, чем хорош">${esc(d.description||'')}</textarea></div>

      <div class="f"><label class="lbl">Характеристики</label>
        <div id="specs"></div>
        <button type="button" class="btn sm ghost" id="spec-add">+ Добавить строку</button></div>

      <div class="sheet-foot">
        <button type="button" class="btn ghost" id="cancel">Отмена</button>
        <button type="submit" class="btn" id="save">${isNew ? 'Создать и опубликовать' : 'Сохранить'}</button>
      </div>
    </form>`);

  let images = [...(d.images || [])];
  let specs  = (d.specs || []).map(s => ({ ...s }));

  const paintImages = () => {
    $('#imgs').innerHTML = images.map((src,i) => `
      <div class="img-box"><img src="${esc(src)}"><button type="button" data-rm="${i}">×</button></div>`).join('')
      + (images.length < 8 ? `<div class="drop" id="drop">+ Загрузить<br>фото</div>` : '');
    $$('[data-rm]').forEach(b => b.onclick = () => { images.splice(+b.dataset.rm, 1); paintImages(); });
    const drop = $('#drop');
    if (drop){
      drop.onclick = () => $('#file').click();
      drop.ondragover = e => { e.preventDefault(); drop.style.borderColor = 'var(--ink)'; };
      drop.ondragleave = () => drop.style.borderColor = '';
      drop.ondrop = e => { e.preventDefault(); drop.style.borderColor = ''; uploadFiles(e.dataTransfer.files); };
    }
  };

  const paintSpecs = () => {
    $('#specs').innerHTML = specs.map((s,i) => `
      <div class="spec-row">
        <input class="inp" placeholder="Параметр" value="${esc(s.k)}" data-k="${i}">
        <input class="inp" placeholder="Значение" value="${esc(s.v)}" data-v="${i}">
        <button type="button" class="btn sm danger" data-sr="${i}">×</button>
      </div>`).join('');
    $$('[data-k]').forEach(inp => inp.oninput = () => specs[+inp.dataset.k].k = inp.value);
    $$('[data-v]').forEach(inp => inp.oninput = () => specs[+inp.dataset.v].v = inp.value);
    $$('[data-sr]').forEach(b => b.onclick = () => { specs.splice(+b.dataset.sr,1); paintSpecs(); });
  };

  async function uploadFiles(files){
    const drop = $('#drop');
    for (const file of [...files].slice(0, 8 - images.length)){
      if (drop) drop.textContent = 'Загружаем…';
      try{
        images.push(await uploadImage(file));
        paintImages();
      }catch(e){ toast(e.message, true); paintImages(); }
    }
  }

  paintImages(); paintSpecs();
  $('#file').onchange = e => uploadFiles(e.target.files);
  $('#spec-add').onclick = () => { specs.push({ k:'', v:'' }); paintSpecs(); };
  $('#cancel').onclick = closeSheet;

  $('#pf').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const title = f.title.value.trim();
    if (!title) return toast('Введите название товара', true);

    const clean = v => Math.max(0, Math.round(parseFloat(String(v).replace(',','.')) || 0));
    const target = isNew
      ? { id: nextId(A.db.products), createdAt: new Date().toISOString().slice(0,19) }
      : A.db.products.find(x => x.id == d.id);

    Object.assign(target, {
      title,
      slug: slugify(title) + '-' + target.id,
      brand: f.brand.value.trim(), category: f.category.value, sku: f.sku.value.trim(),
      price: clean(f.price.value), oldPrice: clean(f.oldPrice.value),
      unit: f.unit.value.trim() || 'шт', badge: f.badge.value,
      inStock: f.inStock.checked, published: f.published.checked,
      description: f.description.value.trim(),
      images: images.slice(0, 8),
      specs: specs.filter(s => s.k.trim()).map(s => ({ k: s.k.trim(), v: s.v.trim() })),
    });
    if (isNew) A.db.products.push(target);

    $('#save').disabled = true; $('#save').textContent = 'Публикуем…';
    try{
      await saveDb((isNew ? 'Новый товар: ' : 'Изменён товар: ') + title);
      counters(); closeSheet(); viewProducts();
      toast(isNew ? 'Товар добавлен, сайт обновляется' : 'Изменения сохранены, сайт обновляется');
    }catch(ex){
      if (isNew) A.db.products = A.db.products.filter(x => x !== target);
      toast(ex.message, true);
      $('#save').disabled = false; $('#save').textContent = isNew ? 'Создать и опубликовать' : 'Сохранить';
    }
  };
}

/* ---------------------------------------------------------- категории */
function viewCategories(){
  const cats = A.db.categories;
  $('#view').innerHTML = `
    <div class="topline">
      <div><h1>Категории</h1><p>Порядок в меню задаётся полем «Сортировка»</p></div>
      <div class="tools"><button class="btn" id="c-add">+ Добавить категорию</button></div>
    </div>
    ${cats.length ? `<table class="table">
      <thead><tr><th>Категория</th><th>Ссылка</th><th>Товаров</th><th>Сортировка</th><th></th></tr></thead>
      <tbody>${cats.map(c => {
        const n = A.db.products.filter(p => p.category === c.slug).length;
        return `<tr>
          <td><div class="cellname"><div class="thumb" style="font-size:17px">${esc(c.icon||'✦')}</div><div><b>${esc(c.title)}</b></div></div></td>
          <td><small style="color:var(--muted)">#/catalog/${esc(c.slug)}</small></td>
          <td>${n}</td>
          <td>${c.sort||0}</td>
          <td><div class="acts">
            <button class="btn sm ghost" data-cedit="${c.id}">Изменить</button>
            <button class="btn sm danger" data-cdel="${c.id}">Удалить</button>
          </div></td></tr>`;
      }).join('')}</tbody></table>`
    : `<div class="empty"><b>Категорий нет</b>Добавьте хотя бы одну, чтобы раскладывать товары.</div>`}`;

  $('#c-add').onclick = () => editCategory(null);
  $$('[data-cedit]').forEach(b => b.onclick = () => editCategory(cats.find(c => c.id == b.dataset.cedit)));
  $$('[data-cdel]').forEach(b => b.onclick = async () => {
    const c = cats.find(x => x.id == b.dataset.cdel);
    const n = A.db.products.filter(p => p.category === c.slug).length;
    if (n) return toast(`В категории ${n} товаров — сначала перенесите их`, true);
    if (!confirm(`Удалить категорию «${c.title}»?`)) return;
    const backup = A.db.categories.slice();
    A.db.categories = A.db.categories.filter(x => x.id != c.id);
    try{
      await saveDb('Удалена категория: ' + c.title);
      counters(); viewCategories(); toast('Категория удалена');
    }catch(e){ A.db.categories = backup; toast(e.message, true); viewCategories(); }
  });
}

function editCategory(c){
  const isNew = !c;
  const d = c || { icon:'✦', sort: A.db.categories.length + 1 };
  openSheet(`
    <h2>${isNew ? 'Новая категория' : 'Категория'}</h2>
    <form id="cf">
      <div class="f"><label class="lbl">Название *</label>
        <input class="inp" name="title" value="${esc(d.title||'')}" placeholder="Аппараты и техника"></div>
      <div class="row3">
        <div class="f"><label class="lbl">Ссылка (латиницей)</label>
          <input class="inp" name="slug" value="${esc(d.slug||'')}" placeholder="apparaty">
          <div class="hint">Оставьте пустым — сделаем сами</div></div>
        <div class="f"><label class="lbl">Значок</label>
          <input class="inp" name="icon" value="${esc(d.icon||'✦')}" maxlength="4"></div>
        <div class="f"><label class="lbl">Сортировка</label>
          <input class="inp" name="sort" type="number" value="${d.sort||0}"></div>
      </div>
      <div class="sheet-foot">
        <button type="button" class="btn ghost" id="cancel">Отмена</button>
        <button type="submit" class="btn" id="csave">${isNew?'Создать':'Сохранить'}</button>
      </div>
    </form>`);
  $('#cancel').onclick = closeSheet;
  $('#cf').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const title = f.title.value.trim();
    if (!title) return toast('Введите название категории', true);
    const target = isNew ? { id: nextId(A.db.categories) } : A.db.categories.find(x => x.id == d.id);
    Object.assign(target, {
      title, slug: (f.slug.value.trim() || slugify(title)),
      icon: f.icon.value.trim() || '✦', sort: +f.sort.value || 0,
    });
    if (isNew) A.db.categories.push(target);
    A.db.categories.sort((a,b) => (a.sort||0) - (b.sort||0) || a.id - b.id);
    $('#csave').disabled = true;
    try{
      await saveDb((isNew ? 'Новая категория: ' : 'Изменена категория: ') + title);
      counters(); closeSheet(); viewCategories(); toast('Сохранено, сайт обновляется');
    }catch(ex){
      if (isNew) A.db.categories = A.db.categories.filter(x => x !== target);
      toast(ex.message, true); $('#csave').disabled = false;
    }
  };
}

/* -------------------------------------------------------------- заказы */
function viewOrders(){
  const wa = 'https://wa.me/' + String(A.db.settings.whatsapp || '').replace(/\D/g,'');
  $('#view').innerHTML = `
    <div class="topline"><div><h1>Заказы</h1><p>Все заказы с сайта приходят в WhatsApp магазина</p></div></div>
    <div class="card" style="max-width:640px">
      <h3>Как приходят заказы</h3>
      <p class="hint" style="margin:0 0 16px">
        Покупатель собирает корзину и заполняет ФИО, город и телефон. После нажатия кнопки у него
        открывается чат с номером <b>${esc(A.db.settings.phone || '')}</b>, где уже готов текст:
        список товаров, количество, суммы, итог и его контакты. Вам остаётся ответить и подтвердить заказ.
      </p>
      <p class="hint" style="margin:0 0 18px">
        История заказов хранится в переписке WhatsApp — отдельная база не нужна и ничего не теряется,
        даже если сайт временно недоступен.
      </p>
      <a class="btn" href="${wa}" target="_blank" rel="noopener">Открыть WhatsApp магазина</a>
    </div>
    <div class="card" style="max-width:640px">
      <h3>Если номер поменялся</h3>
      <p class="hint" style="margin:0">Смените его в разделе «Настройки магазина», поле WhatsApp. Новые заказы сразу пойдут на новый номер.</p>
    </div>`;
}

/* ----------------------------------------------------------- настройки */
function viewSettings(){
  const s = A.db.settings;
  $('#view').innerHTML = `
    <div class="topline">
      <div><h1>Настройки магазина</h1><p>Контакты, тексты и баннеры на главной</p></div>
      <div class="tools"><button class="btn" id="s-save">Сохранить и опубликовать</button></div>
    </div>

    <form id="sf">
      <div class="card">
        <h3>Контакты</h3>
        <div class="row2">
          <div class="f"><label class="lbl">Название магазина</label><input class="inp" name="shopName" value="${esc(s.shopName||'')}"></div>
          <div class="f"><label class="lbl">Короткое описание</label><input class="inp" name="tagline" value="${esc(s.tagline||'')}"></div>
        </div>
        <div class="row3">
          <div class="f"><label class="lbl">Город</label><input class="inp" name="city" value="${esc(s.city||'')}"></div>
          <div class="f"><label class="lbl">Адрес</label><input class="inp" name="address" value="${esc(s.address||'')}"></div>
          <div class="f"><label class="lbl">Режим работы</label><input class="inp" name="hours" value="${esc(s.hours||'')}"></div>
        </div>
        <div class="row3">
          <div class="f"><label class="lbl">Телефон</label><input class="inp" name="phone" value="${esc(s.phone||'')}"></div>
          <div class="f"><label class="lbl">WhatsApp (только цифры)</label><input class="inp" name="whatsapp" value="${esc(s.whatsapp||'')}" placeholder="79285228968">
            <div class="hint">Сюда приходят заказы с сайта</div></div>
          <div class="f"><label class="lbl">Ссылка на Яндекс.Карты</label><input class="inp" name="mapLink" value="${esc(s.mapLink||'')}"></div>
        </div>
      </div>

      <div class="card">
        <h3>Тексты для покупателя</h3>
        <div class="f"><label class="lbl">Доставка</label><textarea class="inp" name="deliveryText">${esc(s.deliveryText||'')}</textarea></div>
        <div class="f"><label class="lbl">Оплата</label><textarea class="inp" name="paymentText">${esc(s.paymentText||'')}</textarea></div>
        <div class="f"><label class="lbl">Гарантия</label><textarea class="inp" name="guaranteeText">${esc(s.guaranteeText||'')}</textarea></div>
        <div class="f" style="max-width:280px"><label class="lbl">Бесплатная доставка от, ₽</label>
          <input class="inp" name="freeDeliveryFrom" type="number" value="${s.freeDeliveryFrom||0}"></div>
      </div>

      <div class="card">
        <h3>Баннеры на главной</h3>
        <div id="slides"></div>
        <button type="button" class="btn sm ghost" id="slide-add">+ Добавить баннер</button>
      </div>
    </form>`;

  let list = (s.heroSlides || []).map(x => ({ ...x }));

  const paint = () => {
    $('#slides').innerHTML = list.map((sl,i) => `
      <div class="card" style="background:#fcfbfa">
        <div class="row2">
          <div class="f"><label class="lbl">Заголовок</label><input class="inp" data-sl="${i}" data-k="title" value="${esc(sl.title||'')}"></div>
          <div class="f"><label class="lbl">Подзаголовок</label><input class="inp" data-sl="${i}" data-k="subtitle" value="${esc(sl.subtitle||'')}"></div>
        </div>
        <div class="row3">
          <div class="f"><label class="lbl">Текст кнопки</label><input class="inp" data-sl="${i}" data-k="button" value="${esc(sl.button||'')}"></div>
          <div class="f"><label class="lbl">Ссылка</label><input class="inp" data-sl="${i}" data-k="link" value="${esc(sl.link||'')}" placeholder="#/catalog/apparaty"></div>
          <div class="f"><label class="lbl">Цвет фона</label><input class="inp" data-sl="${i}" data-k="bg" value="${esc(sl.bg||'#f4f0ee')}"></div>
        </div>
        <div class="f"><label class="lbl">Картинка баннера</label>
          <div class="imgs">
            ${sl.image ? `<div class="img-box"><img src="${esc(sl.image)}"><button type="button" data-slrm="${i}">×</button></div>` : ''}
            <div class="drop" data-slup="${i}">+ Загрузить</div>
          </div>
        </div>
        <button type="button" class="btn sm danger" data-sldel="${i}">Удалить баннер</button>
      </div>`).join('') || '<div class="hint">Баннеров нет — на главной будет сразу каталог.</div>';

    $$('[data-sl]').forEach(inp => inp.oninput = () => list[+inp.dataset.sl][inp.dataset.k] = inp.value);
    $$('[data-sldel]').forEach(b => b.onclick = () => { list.splice(+b.dataset.sldel,1); paint(); });
    $$('[data-slrm]').forEach(b => b.onclick = () => { list[+b.dataset.slrm].image = ''; paint(); });
    $$('[data-slup]').forEach(b => b.onclick = () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = async () => {
        b.textContent = 'Загружаем…';
        try{ list[+b.dataset.slup].image = await uploadImage(inp.files[0]); }
        catch(e){ toast(e.message, true); }
        paint();
      };
      inp.click();
    });
  };
  paint();

  $('#slide-add').onclick = () => { list.push({ title:'Новый баннер', subtitle:'', button:'В каталог', link:'#/catalog', bg:'#f4f0ee', image:'' }); paint(); };

  $('#s-save').onclick = async () => {
    const f = $('#sf');
    const backup = JSON.parse(JSON.stringify(A.db.settings));
    ['shopName','tagline','city','address','hours','phone','whatsapp','mapLink',
     'deliveryText','paymentText','guaranteeText'].forEach(k => A.db.settings[k] = f[k].value.trim());
    A.db.settings.whatsapp = A.db.settings.whatsapp.replace(/\D/g,'');
    A.db.settings.freeDeliveryFrom = +f.freeDeliveryFrom.value || 0;
    A.db.settings.heroSlides = list;
    $('#s-save').disabled = true;
    try{
      await saveDb('Обновлены настройки магазина');
      toast('Настройки сохранены, сайт обновляется');
    }catch(ex){ A.db.settings = backup; toast(ex.message, true); }
    $('#s-save').disabled = false;
  };
}

/* --------------------------------------------------------- безопасность */
function viewSecurity(){
  $('#view').innerHTML = `
    <div class="topline"><div><h1>Безопасность</h1><p>Доступ к панели и резервные копии</p></div></div>

    <div class="card" style="max-width:600px">
      <h3>Кто сейчас в панели</h3>
      <div class="p-line hint" style="margin:0 0 6px">Аккаунт GitHub: <b>${esc(A.user?.login || '—')}</b></div>
      <div class="hint" style="margin:0 0 6px">Репозиторий сайта: <b>${esc(CFG.owner)}/${esc(CFG.repo)}</b></div>
      <div class="hint" style="margin:0 0 18px">Адрес магазина: <a href="${SITE_URL}" target="_blank" rel="noopener" style="text-decoration:underline">${SITE_URL}</a></div>
      <button class="btn ghost" id="drop-token">Выйти и забыть ключ на этом устройстве</button>
    </div>

    <div class="card" style="max-width:600px">
      <h3>Код доступа</h3>
      <p class="hint" style="margin:0 0 16px">
        Код заменяет длинный ключ GitHub при входе на этом устройстве. Ключ хранится здесь же,
        но в зашифрованном виде: без кода его не прочитать. На другом устройстве код нужно задать заново.
      </p>
      <form id="pinf">
        <div class="row2">
          <div class="f"><label class="lbl">Новый код</label>
            <input class="inp" type="password" name="pin" inputmode="numeric" maxlength="12" placeholder="8 цифр"></div>
          <div class="f"><label class="lbl">Повторите код</label>
            <input class="inp" type="password" name="pin2" inputmode="numeric" maxlength="12" placeholder="8 цифр"></div>
        </div>
        <button class="btn" type="submit">${box.get() ? 'Сменить код' : 'Установить код'}</button>
      </form>
    </div>

    <div class="card" style="max-width:600px">
      <h3>Если ключ попал не в те руки</h3>
      <p class="hint" style="margin:0">
        Зайдите на github.com → Settings → Developer settings → Personal access tokens →
        Fine-grained tokens и нажмите Revoke у нужного ключа. Он сразу перестанет работать,
        а вы создадите новый. Сайт и товары при этом не пострадают.
      </p>
    </div>

    <div class="card" style="max-width:600px">
      <h3>Резервная копия</h3>
      <p class="hint" style="margin:0 0 14px">
        Каталог и настройки лежат в файле <b>${esc(CFG.dbPath)}</b> в репозитории, фотографии — в папке
        <b>${esc(CFG.uploadDir)}</b>. GitHub хранит историю всех изменений, поэтому любую правку можно откатить.
        Кнопка ниже скачает текущий каталог себе на устройство.
      </p>
      <button class="btn ghost" id="backup">Скачать копию каталога</button>
    </div>`;

  $('#drop-token').onclick = () => { if (confirm('Выйти и удалить ключ с этого устройства?')) logout(true); };

  $('#pinf').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const pin = f.pin.value.trim(), pin2 = f.pin2.value.trim();
    if (pin !== pin2) return toast('Коды не совпадают', true);
    if (!validPin(pin)) return toast('Код — только цифры, от 4 до 12 знаков', true);
    try{
      box.set(await lockToken(A.token, pin));
      box.bump(0);
      try{ localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); }catch(ex){}
      f.reset();
      toast('Код сохранён. Следующий вход — по нему');
      viewSecurity();
    }catch(ex){ toast('Не удалось сохранить код: ' + ex.message, true); }
  };
  $('#backup').onclick = () => {
    const blob = new Blob([JSON.stringify(A.db, null, 2)], { type:'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nogotok-katalog-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
}

/* ------------------------------------------------------------- модалка */
function openSheet(html){
  $('#sheet').innerHTML = html;
  $('#back').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeSheet(){
  $('#back').classList.remove('open');
  document.body.style.overflow = '';
}
$('#back').onclick = e => { if (e.target.id === 'back') closeSheet(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

/* --------------------------------------------------------------- старт */
pickLoginMode();
if (A.token){
  start().catch(() => logout());
}
