/* ============ Ноготок — панель управления (данные хранятся на GitHub) ============ */

const CFG = window.SHOP_CONFIG;
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => new Intl.NumberFormat('ru-RU').format(Math.round(n || 0)) + ' ₽';
const TOKEN_KEY = 'nogotok_gh_token';
const SITE_URL = CFG.siteUrl || `https://${CFG.owner}.github.io/${CFG.repo}/`;

const A = { token: '', user: null, db: null, sha: '', tab: 'products', filter: { q:'', cat:'' }, busy: false };

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

function logout(){
  try{ localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); }catch(e){}
  A.token = ''; A.db = null; A.user = null;
  $('#panel').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

/* ------------------------------------------------------------------ вход */
function showLoginError(text){
  const err = $('#login-error');
  err.textContent = text;
  err.style.display = text ? 'block' : 'none';
}

$('#login-form').onsubmit = async e => {
  e.preventDefault();
  const btn = $('#login-btn');
  const token = $('#password').value.trim();
  if (!token) return showLoginError('Вставьте ключ доступа GitHub');
  btn.disabled = true; btn.textContent = 'Проверяем ключ…';
  showLoginError('');
  A.token = token;
  try{
    A.user = await gh('/user');
    const repo = await gh(`/repos/${CFG.owner}/${CFG.repo}`);
    if (repo.permissions && repo.permissions.push === false)
      console.warn('Ключ выглядит как «только чтение» — сохранение может не пройти');
    try{
      const store = $('#remember').checked ? localStorage : sessionStorage;
      store.setItem(TOKEN_KEY, token);
    }catch(ex){}
    $('#password').value = '';
    await start();
  }catch(ex){
    A.token = '';
    showLoginError(ex.status === 404
      ? `Репозиторий ${CFG.owner}/${CFG.repo} не найден или ключ не даёт к нему доступа`
      : ex.message);
  }finally{
    btn.disabled = false; btn.textContent = 'Войти';
  }
};

$('#logout').onclick = e => { e.preventDefault(); logout(); };
$$('#nav button').forEach(b => b.onclick = () => { A.tab = b.dataset.tab; render(); });

$('#help-link').onclick = e => {
  e.preventDefault();
  alert(
    'Как получить ключ доступа:\n\n' +
    '1. Зайдите на github.com под аккаунтом с доступом к ' + CFG.owner + '\n' +
    '2. Settings → Developer settings → Personal access tokens → Fine-grained tokens\n' +
    '3. Generate new token. Имя любое, срок — на год.\n' +
    '4. Resource owner → ' + CFG.owner + ', Repository access → Only select repositories → ' + CFG.repo + '\n' +
    '5. Permissions → Repository permissions → Contents: Read and write\n' +
    '6. Generate token и скопируйте строку, которая начинается на github_pat_'
  );
};

async function start(){
  await loadDb();
  $('#login').classList.add('hidden');
  $('#panel').classList.remove('hidden');
  counters();
  render();
}

function counters(){
  A.db.settings.brands = A.db.settings.brands || [];
  A.db.settings.attributes = A.db.settings.attributes || [];
  $('#n-products').textContent = A.db.products.length;
  $('#n-brands').textContent = A.db.settings.brands.length;
  $('#n-categories').textContent = A.db.categories.length;
  $('#n-attributes').textContent = A.db.settings.attributes.length;
}

/* Сколько товаров у бренда и у значения характеристики. */
const usedBrand = name => A.db.products.filter(p => (p.brand||'').trim() === name).length;
const usedAttr  = (key, val) => A.db.products.filter(p => (p.attrs||{})[key] === val).length;

function render(){
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === A.tab));
  ({ products: viewProducts, brands: viewBrands, categories: viewCategories,
     attributes: viewAttributes, orders: viewOrders,
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
  const d = p || { images: [], attrs: {}, inStock: true, published: true, unit: 'шт', price: 0, oldPrice: 0,
                   category: (A.db.categories[0] || {}).slug || '' };

  openSheet(`
    <h2>${isNew ? 'Новый товар' : 'Редактирование товара'}</h2>
    <form id="pf">
      <div class="f"><label class="lbl">Название *</label>
        <input class="inp" name="title" value="${esc(d.title||'')}" placeholder="Фрезер для маникюра Strong 210"></div>

      <div class="row3">
        <div class="f"><label class="lbl">Категория *</label>
          <select class="inp" name="category">
            ${A.db.categories.filter(c => !c.parent).map(c => `
              <option value="${esc(c.slug)}" ${d.category===c.slug?'selected':''}>${esc(c.title)}</option>
              ${A.db.categories.filter(k => k.parent === c.slug).map(k =>
                `<option value="${esc(k.slug)}" ${d.category===k.slug?'selected':''}>&nbsp;&nbsp;&nbsp;└ ${esc(k.title)}</option>`).join('')}
            `).join('')}
          </select></div>
        <div class="f"><label class="lbl">Бренд</label>
          <select class="inp" name="brand">
            <option value="">— без бренда —</option>
            ${(A.db.settings.brands || []).map(b =>
              `<option value="${esc(b)}" ${d.brand === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}
          </select>
          <div class="hint">Список брендов — в разделе «Бренды»</div></div>
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
        <div class="hint" style="margin:0 0 12px">
          По ним покупатель фильтрует каталог. Набор характеристик задаётся в разделе «Характеристики»,
          кнопка «+» добавляет новое значение прямо отсюда.
        </div>
        <div id="attrs"></div>
      </div>

      <div class="sheet-foot">
        <button type="button" class="btn ghost" id="cancel">Отмена</button>
        <button type="submit" class="btn" id="save">${isNew ? 'Создать и опубликовать' : 'Сохранить'}</button>
      </div>
    </form>`);

  let images = [...(d.images || [])];
  const chosen = { ...(d.attrs || {}) };

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

  const paintAttrs = () => {
    const attrs = A.db.settings.attributes || [];
    $('#attrs').innerHTML = attrs.length ? attrs.map(a => `
      <div class="f">
        <label class="lbl">${esc(a.name)}</label>
        <div class="attr-row">
          <select class="inp" data-attr="${esc(a.name)}">
            <option value="">— не указано —</option>
            ${a.values.map(v => `<option value="${esc(v)}" ${chosen[a.name] === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}
          </select>
          <button type="button" class="btn ghost" data-attr-add="${esc(a.name)}" title="Добавить новое значение">+</button>
        </div>
      </div>`).join('')
      : '<div class="hint">Характеристик пока нет. Добавьте их в разделе «Характеристики».</div>';

    $$('[data-attr]').forEach(sel => sel.onchange = () => { chosen[sel.dataset.attr] = sel.value; });
    $$('[data-attr-add]').forEach(btn => btn.onclick = () => {
      const name = btn.dataset.attrAdd;
      const attr = (A.db.settings.attributes || []).find(a => a.name === name);
      const value = (prompt(`Новое значение для «${name}»`, '') || '').trim();
      if (!attr || !value) return;
      if (!attr.values.includes(value)){
        attr.values = [...attr.values, value].sort((x,y) => x.localeCompare(y,'ru',{numeric:true}));
      }
      chosen[name] = value;
      paintAttrs();
    });
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

  paintImages(); paintAttrs();
  $('#file').onchange = e => uploadFiles(e.target.files);
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
      attrs: Object.fromEntries(Object.entries(chosen).filter(([, v]) => v)),
    });
    if (isNew) A.db.products.push(target);

    const brand = target.brand.trim();
    if (brand){
      A.db.settings.brands = A.db.settings.brands || [];
      if (!A.db.settings.brands.includes(brand)){
        A.db.settings.brands.push(brand);
        A.db.settings.brands.sort((x,y) => x.toLowerCase().localeCompare(y.toLowerCase(), 'ru'));
      }
    }

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

/* ------------------------------------------------------------- бренды */
function viewBrands(){
  const brands = A.db.settings.brands || [];
  $('#view').innerHTML = `
    <div class="topline">
      <div><h1>Бренды</h1><p>Из этого списка бренд выбирается в карточке товара. На сайте показываются только бренды с товарами</p></div>
      <div class="tools">
        <input class="inp" id="b-new" placeholder="Название бренда" style="width:220px">
        <button class="btn" id="b-add">+ Добавить бренд</button>
      </div>
    </div>
    ${brands.length ? `<table class="table">
      <thead><tr><th>Бренд</th><th>Товаров</th><th>На сайте</th><th></th></tr></thead>
      <tbody>${brands.map((b,i) => `
        <tr>
          <td><div class="cellname">
            <div class="thumb" style="font-size:15px">◆</div>
            <div><b>${esc(b)}</b></div>
          </div></td>
          <td>${usedBrand(b)}</td>
          <td>${usedBrand(b) ? '<span class="tag on">виден</span>' : '<span class="tag">пока скрыт</span>'}</td>
          <td><div class="acts">
            <button class="btn sm ghost" data-bren="${i}">Переименовать</button>
            <button class="btn sm danger" data-bdel="${i}">Удалить</button>
          </div></td>
        </tr>`).join('')}</tbody>
    </table>`
    : `<div class="empty"><b>Брендов нет</b>Добавьте первый бренд, и он появится в карточке товара.</div>`}`;

  const addBrand = async () => {
    const name = $('#b-new').value.trim();
    if (!name) return;
    if (brands.some(b => b.toLowerCase() === name.toLowerCase())) return toast('Такой бренд уже есть', true);
    A.db.settings.brands = [...brands, name].sort((x,y) => x.toLowerCase().localeCompare(y.toLowerCase(),'ru'));
    try{ await saveDb('Добавлен бренд: ' + name); counters(); viewBrands(); toast('Бренд добавлен'); }
    catch(e){ A.db.settings.brands = brands; toast(e.message, true); }
  };
  $('#b-add').onclick = addBrand;
  $('#b-new').onkeydown = e => { if (e.key === 'Enter'){ e.preventDefault(); addBrand(); } };

  $$('[data-bren]').forEach(b => b.onclick = async () => {
    const i = +b.dataset.bren, was = brands[i];
    const name = (prompt('Новое название бренда', was) || '').trim();
    if (!name || name === was) return;
    const next = brands.slice(); next[i] = name;
    const backup = A.db.products.map(p => p.brand);
    A.db.settings.brands = next.sort((x,y) => x.toLowerCase().localeCompare(y.toLowerCase(),'ru'));
    A.db.products.forEach(p => { if ((p.brand||'').trim() === was) p.brand = name; });
    try{ await saveDb(`Бренд «${was}» переименован в «${name}»`); counters(); viewBrands(); toast('Переименовано'); }
    catch(e){
      A.db.settings.brands = brands;
      A.db.products.forEach((p,k) => p.brand = backup[k]);
      toast(e.message, true);
    }
  });

  $$('[data-bdel]').forEach(b => b.onclick = async () => {
    const i = +b.dataset.bdel, name = brands[i];
    if (usedBrand(name)) return toast(`«${name}» стоит у ${usedBrand(name)} товаров — сначала смените бренд у них`, true);
    if (!confirm(`Удалить бренд «${name}»?`)) return;
    A.db.settings.brands = brands.filter((_,k) => k !== i);
    try{ await saveDb('Удалён бренд: ' + name); counters(); viewBrands(); toast('Бренд удалён'); }
    catch(e){ A.db.settings.brands = brands; toast(e.message, true); }
  });
}

/* ------------------------------------------------------ характеристики */
function viewAttributes(){
  const attrs = A.db.settings.attributes || [];
  $('#view').innerHTML = `
    <div class="topline">
      <div><h1>Характеристики</h1><p>Из них собираются фильтры в каталоге. Значения выбираются в карточке товара</p></div>
      <div class="tools">
        <input class="inp" id="a-new" placeholder="Например: Объём" style="width:220px">
        <button class="btn" id="a-add">+ Добавить характеристику</button>
      </div>
    </div>

    ${attrs.length ? attrs.map((a,i) => `
      <div class="card">
        <div class="topline" style="margin-bottom:14px">
          <div><h3>${esc(a.name)}</h3>
            <p>${a.values.length} ${a.values.length===1?'значение':'значений'} · фильтр появится, когда значения будут у товаров</p></div>
          <div class="tools">
            <button class="btn sm ghost" data-aren="${i}">Переименовать</button>
            <button class="btn sm danger" data-adel="${i}">Удалить</button>
          </div>
        </div>
        <div class="brand-chips">
          ${a.values.map((v,j) => `
            <span class="chip-row">${esc(v)}<small>${usedAttr(a.name, v)}</small>
              <button type="button" data-vdel="${i}:${j}" title="Убрать значение">×</button></span>`).join('')
            || '<div class="hint">Значений нет. Добавьте их здесь или прямо в карточке товара.</div>'}
        </div>
        <div class="row2" style="align-items:end;margin-top:14px">
          <div class="f" style="margin:0"><label class="lbl">Новое значение</label>
            <input class="inp" data-vnew="${i}" placeholder="15 мл"></div>
          <div class="f" style="margin:0"><button class="btn ghost" data-vadd="${i}">Добавить значение</button></div>
        </div>
      </div>`).join('')
    : `<div class="empty"><b>Характеристик нет</b>Добавьте, например, «Объём» или «Тип товара» — по ним покупатель будет фильтровать каталог.</div>`}`;

  const save = async (message, revert) => {
    try{ await saveDb(message); counters(); viewAttributes(); toast('Сохранено'); }
    catch(e){ revert(); toast(e.message, true); viewAttributes(); }
  };

  const addAttr = () => {
    const name = $('#a-new').value.trim();
    if (!name) return;
    if (attrs.some(a => a.name.toLowerCase() === name.toLowerCase())) return toast('Такая характеристика уже есть', true);
    const backup = attrs.slice();
    A.db.settings.attributes = [...attrs, { name, values: [] }];
    save('Добавлена характеристика: ' + name, () => A.db.settings.attributes = backup);
  };
  $('#a-add').onclick = addAttr;
  $('#a-new').onkeydown = e => { if (e.key === 'Enter'){ e.preventDefault(); addAttr(); } };

  $$('[data-aren]').forEach(b => b.onclick = () => {
    const a = attrs[+b.dataset.aren], was = a.name;
    const name = (prompt('Новое название характеристики', was) || '').trim();
    if (!name || name === was) return;
    a.name = name;
    A.db.products.forEach(p => {
      if (p.attrs && was in p.attrs){ p.attrs[name] = p.attrs[was]; delete p.attrs[was]; }
    });
    save(`Характеристика «${was}» переименована в «${name}»`, () => { a.name = was; });
  });

  $$('[data-adel]').forEach(b => b.onclick = () => {
    const a = attrs[+b.dataset.adel];
    const used = A.db.products.filter(p => (p.attrs||{})[a.name]).length;
    if (used) return toast(`«${a.name}» заполнена у ${used} товаров — сначала очистите её там`, true);
    if (!confirm(`Удалить характеристику «${a.name}»?`)) return;
    const backup = attrs.slice();
    A.db.settings.attributes = attrs.filter((_,k) => k !== +b.dataset.adel);
    save('Удалена характеристика: ' + a.name, () => A.db.settings.attributes = backup);
  });

  $$('[data-vadd]').forEach(b => b.onclick = () => {
    const i = +b.dataset.vadd;
    const input = $(`[data-vnew="${i}"]`);
    const value = input.value.trim();
    if (!value) return;
    if (attrs[i].values.includes(value)) return toast('Такое значение уже есть', true);
    attrs[i].values = [...attrs[i].values, value].sort((x,y) => x.localeCompare(y,'ru',{numeric:true}));
    save(`Значение «${value}» в характеристике «${attrs[i].name}»`, () => {
      attrs[i].values = attrs[i].values.filter(v => v !== value);
    });
  });
  $$('[data-vnew]').forEach(inp => inp.onkeydown = e => {
    if (e.key === 'Enter'){ e.preventDefault(); $(`[data-vadd="${inp.dataset.vnew}"]`).click(); }
  });

  $$('[data-vdel]').forEach(b => b.onclick = () => {
    const [i, j] = b.dataset.vdel.split(':').map(Number);
    const value = attrs[i].values[j];
    if (usedAttr(attrs[i].name, value)) return toast(`«${value}» стоит у ${usedAttr(attrs[i].name, value)} товаров`, true);
    const backup = attrs[i].values.slice();
    attrs[i].values = attrs[i].values.filter((_,k) => k !== j);
    save(`Убрано значение «${value}»`, () => attrs[i].values = backup);
  });
}

/* ---------------------------------------------------------- категории */
function viewCategories(){
  const cats = A.db.categories;
  const tops = cats.filter(c => !c.parent).sort((a,b) => (a.sort||0)-(b.sort||0) || a.id-b.id);
  const kidsOf = slug => cats.filter(c => c.parent === slug).sort((a,b) => (a.sort||0)-(b.sort||0) || a.id-b.id);
  const own = slug => A.db.products.filter(p => p.category === slug).length;
  const total = c => own(c.slug) + kidsOf(c.slug).reduce((n,k) => n + own(k.slug), 0);

  const row = (c, isChild) => {
    const n = isChild ? own(c.slug) : total(c);
    return `<tr>
      <td><div class="cellname">
        <div class="thumb" style="font-size:17px">${isChild ? '•' : esc(c.icon||'✦')}</div>
        <div><b>${isChild ? '<span style="color:var(--muted)">└ </span>' : ''}${esc(c.title)}</b>
          <small>${isChild ? 'подгруппа' : (kidsOf(c.slug).length ? kidsOf(c.slug).length + ' подгрупп' : 'раздел')}</small></div>
      </div></td>
      <td><small style="color:var(--muted)">#/catalog/${esc(c.slug)}</small></td>
      <td>${n}${n === 0 ? '<br><small style="color:var(--muted)">на сайте не видна</small>' : ''}</td>
      <td>${c.sort||0}</td>
      <td><div class="acts">
        <button class="btn sm ghost" data-cedit="${c.id}">Изменить</button>
        <button class="btn sm danger" data-cdel="${c.id}">Удалить</button>
      </div></td></tr>`;
  };

  $('#view').innerHTML = `
    <div class="topline">
      <div><h1>Категории</h1><p>Разделы и подгруппы каталога. Пустые разделы покупателю не показываются</p></div>
      <div class="tools"><button class="btn" id="c-add">+ Добавить категорию</button></div>
    </div>
    ${cats.length ? `<table class="table">
      <thead><tr><th>Название</th><th>Ссылка</th><th>Товаров</th><th>Сортировка</th><th></th></tr></thead>
      <tbody>${tops.map(c => row(c, false) + kidsOf(c.slug).map(k => row(k, true)).join('')).join('')}</tbody>
    </table>`
    : `<div class="empty"><b>Категорий нет</b>Добавьте хотя бы одну, чтобы раскладывать товары.</div>`}`;

  $('#c-add').onclick = () => editCategory(null);
  $$('[data-cedit]').forEach(b => b.onclick = () => editCategory(cats.find(c => c.id == b.dataset.cedit)));
  $$('[data-cdel]').forEach(b => b.onclick = async () => {
    const c = cats.find(x => x.id == b.dataset.cdel);
    const n = A.db.products.filter(p => p.category === c.slug).length;
    if (n) return toast(`В категории ${n} товаров — сначала перенесите их`, true);
    if (kidsOf(c.slug).length) return toast('Сначала удалите или перенесите подгруппы', true);
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
  const d = c || { icon:'✦', parent:'', sort: A.db.categories.length + 1 };
  openSheet(`
    <h2>${isNew ? 'Новая категория' : 'Категория'}</h2>
    <form id="cf">
      <div class="f"><label class="lbl">Название *</label>
        <input class="inp" name="title" value="${esc(d.title||'')}" placeholder="Аппараты и техника"></div>
      <div class="f"><label class="lbl">Внутри раздела</label>
        <select class="inp" name="parent">
          <option value="">— самостоятельный раздел —</option>
          ${A.db.categories.filter(x => !x.parent && x.slug !== d.slug).map(x =>
            `<option value="${esc(x.slug)}" ${d.parent === x.slug ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}
        </select>
        <div class="hint">Выберите раздел, если это подгруппа. Подгруппы второго уровня не поддерживаются</div>
      </div>

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
    const parent = f.parent.value;
    const hasKids = A.db.categories.some(x => x.parent === (d.slug || ''));
    if (parent && hasKids) return toast('У этой категории есть подгруппы, она не может быть вложенной', true);
    Object.assign(target, {
      title, slug: (f.slug.value.trim() || slugify(title)),
      icon: f.icon.value.trim() || '✦', sort: +f.sort.value || 0, parent,
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
        <h3>Бренды магазина</h3>
        <p class="hint" style="margin:0 0 14px">
          Из этого списка бренд подставляется при добавлении товара. На сайте в разделе
          «Все бренды» показываются только те, у которых есть товары.
        </p>
        <div id="brands"></div>
        <div class="row2" style="align-items:end">
          <div class="f" style="margin:0"><label class="lbl">Новый бренд</label>
            <input class="inp" id="brand-new" placeholder="Zinger"></div>
          <div class="f" style="margin:0"><button type="button" class="btn ghost" id="brand-add">Добавить бренд</button></div>
        </div>
      </div>

      <div class="card">
        <h3>Баннеры на главной</h3>
        <div id="slides"></div>
        <button type="button" class="btn sm ghost" id="slide-add">+ Добавить баннер</button>
      </div>
    </form>`;

  let brands = [...(s.brands || [])];
  const paintBrands = () => {
    const used = b => A.db.products.filter(p => (p.brand||'').trim() === b).length;
    $('#brands').innerHTML = brands.length
      ? `<div class="brand-chips">${brands.map((b,i) => `
          <span class="chip-row">${esc(b)}<small>${used(b)}</small>
            <button type="button" data-brm="${i}" title="Убрать из списка">×</button></span>`).join('')}</div>`
      : '<div class="hint">Список пуст. Бренд можно вписать прямо в карточке товара.</div>';
    $$('[data-brm]').forEach(b => b.onclick = () => {
      const name = brands[+b.dataset.brm];
      const n = A.db.products.filter(p => (p.brand||'').trim() === name).length;
      if (n) return toast(`«${name}» стоит у ${n} товаров, сначала смените бренд у них`, true);
      brands.splice(+b.dataset.brm, 1); paintBrands();
    });
  };

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
  paintBrands();

  $('#brand-add').onclick = () => {
    const name = $('#brand-new').value.trim();
    if (!name) return;
    if (brands.some(b => b.toLowerCase() === name.toLowerCase())) return toast('Такой бренд уже есть', true);
    brands.push(name);
    brands.sort((x,y) => x.toLowerCase().localeCompare(y.toLowerCase(), 'ru'));
    $('#brand-new').value = '';
    paintBrands();
  };

  $('#slide-add').onclick = () => { list.push({ title:'Новый баннер', subtitle:'', button:'В каталог', link:'#/catalog', bg:'#f4f0ee', image:'' }); paint(); };

  $('#s-save').onclick = async () => {
    const f = $('#sf');
    const backup = JSON.parse(JSON.stringify(A.db.settings));
    ['shopName','tagline','city','address','hours','phone','whatsapp','mapLink',
     'deliveryText','paymentText','guaranteeText'].forEach(k => A.db.settings[k] = f[k].value.trim());
    A.db.settings.whatsapp = A.db.settings.whatsapp.replace(/\D/g,'');
    A.db.settings.freeDeliveryFrom = +f.freeDeliveryFrom.value || 0;
    A.db.settings.heroSlides = list;
    A.db.settings.brands = brands;
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

  $('#drop-token').onclick = () => { if (confirm('Выйти и удалить ключ с этого устройства?')) logout(); };

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
if (A.token){
  start().catch(() => logout());
}
