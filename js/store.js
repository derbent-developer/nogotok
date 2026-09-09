/* ===================== Ноготок — витрина магазина ===================== */

const S = { settings:{}, categories:[], products:[], cart:[], ready:false };
const CART_KEY = 'nogotok_cart_v1';

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const money = n => new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ₽';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ------------------------------------------------------------- загрузка */
async function boot(){
  try{
    const r = await fetch('data/db.json?v=' + Date.now(), { cache:'no-store' });
    const d = await r.json();
    S.settings = d.settings || {};
    S.categories = d.categories || [];
    S.products = (d.products || []).filter(p => p.published !== false);
  }catch(e){
    $('#app').innerHTML = '<div class="wrap empty"><b>Каталог не загрузился</b>Проверьте интернет и обновите страницу.</div>';
    return;
  }
  S.cart = loadCart();
  S.ready = true;
  paintChrome();
  updateCart();
  window.addEventListener('hashchange', route);
  route();
}

function loadCart(){
  try{ return JSON.parse(localStorage.getItem(CART_KEY)) || []; }catch(e){ return []; }
}
function saveCart(){
  try{ localStorage.setItem(CART_KEY, JSON.stringify(S.cart)); }catch(e){}
}

/* --------------------------------------------------- шапка / футер / меню */
function waLink(text){
  const num = (S.settings.whatsapp || '').replace(/\D/g,'');
  return 'https://wa.me/' + num + (text ? '?text=' + encodeURIComponent(text) : '');
}

function paintChrome(){
  const s = S.settings;
  $('#logo-name').textContent = s.shopName || 'НОГОТОК';
  $('#tb-city').textContent = s.city || '';
  $('#tb-address').textContent = s.address || '';
  $('#tb-hours').textContent = s.hours || '';
  $('#tb-phone').href = 'tel:' + (s.phone || '').replace(/[^\d+]/g,'');
  $('#tb-phone b').textContent = s.phone || '';
  $('#wa-header').href = waLink('Здравствуйте! Пишу с сайта «' + (s.shopName||'Ноготок') + '».');
  $('#f-wa').href = $('#wa-header').href;
  $('#f-map').href = s.mapLink || '#';
  $('#f-tagline').textContent = s.tagline || '';
  $('#f-phone').textContent = s.phone || '';
  $('#f-address').textContent = [s.city, s.address].filter(Boolean).join(', ');
  $('#f-hours').textContent = s.hours || '';
  $('#year').textContent = new Date().getFullYear();

  const cats = S.categories;
  $('#topnav').innerHTML =
    cats.slice(0,8).map(c => `<a href="#/catalog/${c.slug}">${esc(c.title)}</a>`).join('') +
    `<a href="#/catalog?badge=sale" class="accent">Скидки</a><a href="#/delivery">Доставка</a>`;

  $('#megamenu-grid').innerHTML = cats.map(c => `
    <a class="megamenu-item" href="#/catalog/${c.slug}">
      <span class="ic">${esc(c.icon || '✦')}</span>
      <span>${esc(c.title)}<br><small style="color:var(--muted);font-size:11px">${countIn(c.slug)} ${plural(countIn(c.slug),'товар','товара','товаров')}</small></span>
    </a>`).join('');

  $('#f-cats').innerHTML = cats.slice(0,7)
    .map(c => `<li><a href="#/catalog/${c.slug}">${esc(c.title)}</a></li>`).join('');
}

const countIn = slug => S.products.filter(p => p.category === slug).length;
const catTitle = slug => (S.categories.find(c => c.slug === slug) || {}).title || 'Каталог';

/* ------------------------------------------------------------- роутинг */
function parseHash(){
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { parts: path.split('/').filter(Boolean), q: new URLSearchParams(qs || '') };
}

function route(){
  const { parts, q } = parseHash();
  window.scrollTo({ top:0, behavior:'instant' in document.body.style ? 'instant' : 'auto' });
  closeMega();
  const page = parts[0] || 'home';
  if (page === 'home')     return renderHome();
  if (page === 'catalog')  return renderCatalog(parts[1] || '', q);
  if (page === 'product')  return renderProduct(parts[1]);
  if (page === 'contacts') return renderContacts();
  if (page === 'delivery') return renderDelivery();
  renderHome();
}

/* ----------------------------------------------------------- компоненты */
function placeholder(title){
  const initials = String(title||'').replace(/[^А-Яа-яA-Za-z ]/g,'').trim().split(/\s+/).slice(0,2)
    .map(w => w[0]).join('').toUpperCase();
  return `<div class="ph"><span><em>${esc(initials || 'НГ')}</em>${esc((title||'').slice(0,42))}</span></div>`;
}

function picture(p, cls){
  return p.images && p.images[0]
    ? `<img class="${cls||''}" src="${esc(p.images[0])}" alt="${esc(p.title)}" loading="lazy">`
    : placeholder(p.title);
}

const BADGES = { hit:['hit','Хит'], new:['new','Новинка'], sale:['sale','Скидка'] };

function cardHTML(p){
  const inCart = S.cart.find(i => i.id === p.id);
  const discount = p.oldPrice > p.price ? Math.round((1 - p.price / p.oldPrice) * 100) : 0;
  const badge = BADGES[p.badge];
  return `
  <article class="card" data-id="${p.id}">
    <a href="#/product/${p.id}" class="card-media">
      <div class="card-badges">
        ${discount ? `<span class="chip sale">−${discount}%</span>` : ''}
        ${badge ? `<span class="chip ${badge[0]}">${badge[1]}</span>` : ''}
        ${p.inStock ? '' : '<span class="chip out">Под заказ</span>'}
      </div>
      ${picture(p)}
    </a>
    <div class="card-brand">${esc(p.brand || 'Ноготок')}</div>
    <a href="#/product/${p.id}"><div class="card-title">${esc(p.title)}</div></a>
    <div class="card-prices">
      <span class="price ${discount ? 'red' : ''}">${money(p.price)}</span>
      ${p.oldPrice > p.price ? `<span class="price-old">${money(p.oldPrice)}</span>` : ''}
    </div>
    <button class="card-buy ${inCart ? 'added' : ''}" data-add="${p.id}">
      ${inCart ? 'В корзине · ' + inCart.qty + ' шт' : 'В корзину'}
    </button>
  </article>`;
}

function uspHTML(){
  const s = S.settings;
  return `<div class="usp">
    <div><b>Доставка</b><p>${esc(s.deliveryText||'')}</p></div>
    <div><b>Оплата</b><p>${esc(s.paymentText||'')}</p></div>
    <div><b>Гарантия</b><p>${esc(s.guaranteeText||'')}</p></div>
    <div><b>Заказ в WhatsApp</b><p>Соберите корзину и заполните форму — заказ придёт нам в WhatsApp, ответим в рабочее время.</p></div>
  </div>`;
}

/* -------------------------------------------------------------- главная */
function renderHome(){
  const slides = S.settings.heroSlides || [];
  const hits = S.products.filter(p => p.badge === 'hit').slice(0,10);
  const fresh = S.products.filter(p => p.badge === 'new' || p.badge === 'sale').slice(0,10);
  const rest = S.products.slice(0,15);

  $('#app').innerHTML = `
  <div class="wrap">
    <section class="hero">
      <div class="hero-track" id="hero-track">
        ${slides.map(sl => `
          <div class="hero-slide" style="background:${sl.image ? `url('${esc(sl.image)}') center/cover` : esc(sl.bg||'#f4f0ee')}">
            <div>
              <h1>${esc(sl.title)}</h1>
              <p>${esc(sl.subtitle||'')}</p>
              <a class="btn" href="${esc(sl.link||'#/catalog')}">${esc(sl.button||'Смотреть')}</a>
            </div>
          </div>`).join('')}
      </div>
      ${slides.length>1?`
      <button class="hero-arrow prev" id="hero-prev">‹</button>
      <button class="hero-arrow next" id="hero-next">›</button>
      <div class="hero-dots" id="hero-dots">${slides.map((_,i)=>`<button data-i="${i}" class="${i?'':'on'}"></button>`).join('')}</div>`:''}
    </section>

    <section class="section">
      <div class="section-head"><h2>Категории</h2><a href="#/catalog">Весь каталог</a></div>
      <div class="tiles">
        ${S.categories.map(c => `
          <a class="tile" href="#/catalog/${c.slug}">
            <span class="ic">${esc(c.icon||'✦')}</span>
            <span><b>${esc(c.title)}</b><small>${countIn(c.slug)} ${plural(countIn(c.slug),'товар','товара','товаров')}</small></span>
          </a>`).join('')}
      </div>
    </section>

    ${hits.length ? `<section class="section">
      <div class="section-head"><h2>Хиты продаж</h2><a href="#/catalog">Все товары</a></div>
      <div class="grid rail">${hits.map(cardHTML).join('')}</div>
    </section>` : ''}

    ${fresh.length ? `<section class="section">
      <div class="section-head"><h2>Новинки и скидки</h2><a href="#/catalog?badge=sale">Все акции</a></div>
      <div class="grid rail">${fresh.map(cardHTML).join('')}</div>
    </section>` : ''}

    <section class="section">
      <div class="section-head"><h2>В наличии в Дербенте</h2><a href="#/catalog">Показать всё</a></div>
      <div class="grid">${rest.map(cardHTML).join('')}</div>
    </section>

    ${uspHTML()}
  </div>`;

  if (slides.length > 1) initHero(slides.length);
}

function initHero(count){
  let i = 0;
  const track = $('#hero-track');
  const go = n => {
    i = (n + count) % count;
    track.style.transform = `translateX(-${i*100}%)`;
    $$('#hero-dots button').forEach((b,k) => b.classList.toggle('on', k === i));
  };
  $('#hero-next').onclick = () => go(i+1);
  $('#hero-prev').onclick = () => go(i-1);
  $$('#hero-dots button').forEach(b => b.onclick = () => go(+b.dataset.i));
  clearInterval(window.__hero);
  window.__hero = setInterval(() => { if (document.body.contains(track)) go(i+1); else clearInterval(window.__hero); }, 6000);
}

/* -------------------------------------------------------------- каталог */
function renderCatalog(slug, q){
  const query   = (q.get('q') || '').trim().toLowerCase();
  const sort    = q.get('sort') || 'pop';
  const min     = parseFloat(q.get('min')) || 0;
  const max     = parseFloat(q.get('max')) || Infinity;
  const onlyIn  = q.get('stock') === '1';
  const brand   = q.get('brand') || '';
  const badge   = q.get('badge') || '';

  let list = S.products.slice();
  if (slug)  list = list.filter(p => p.category === slug);
  if (badge) list = list.filter(p => p.badge === badge || (badge==='sale' && p.oldPrice > p.price));
  if (brand) list = list.filter(p => p.brand === brand);
  if (onlyIn) list = list.filter(p => p.inStock);
  list = list.filter(p => p.price >= min && p.price <= max);
  if (query) list = list.filter(p =>
    (p.title + ' ' + p.brand + ' ' + p.description + ' ' + p.sku).toLowerCase().includes(query));

  const sorters = {
    pop:      (a,b) => (b.badge==='hit') - (a.badge==='hit') || a.id - b.id,
    price_asc:(a,b) => a.price - b.price,
    price_desc:(a,b)=> b.price - a.price,
    name:     (a,b) => a.title.localeCompare(b.title,'ru'),
    new:      (a,b) => b.id - a.id,
  };
  list.sort(sorters[sort] || sorters.pop);

  const scope = slug ? S.products.filter(p => p.category === slug) : S.products;
  const brands = [...new Set(scope.map(p => p.brand).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'));
  const title = query ? `Поиск: «${esc(query)}»` : (slug ? catTitle(slug) : (badge==='sale' ? 'Скидки и акции' : 'Весь каталог'));

  const link = extra => {
    const p = new URLSearchParams(q.toString());
    Object.entries(extra).forEach(([k,v]) => v === null || v === '' ? p.delete(k) : p.set(k,v));
    const s = p.toString();
    return '#/catalog' + (slug ? '/'+slug : '') + (s ? '?'+s : '');
  };

  $('#app').innerHTML = `
  <div class="wrap">
    <div class="crumbs"><a href="#/">Главная</a> / <a href="#/catalog">Каталог</a>${slug ? ' / <span>'+esc(catTitle(slug))+'</span>' : ''}</div>
    <h1 class="page-title">${title}</h1>
    <div class="page-sub">${list.length} ${plural(list.length,'товар','товара','товаров')} · цены действительны при заказе через сайт</div>

    <div class="catalog">
      <aside class="filters">
        <div>
          <h4>Категории</h4>
          <ul>
            <li><a href="#/catalog" class="${slug?'':'on'}">Все категории <small>${S.products.length}</small></a></li>
            ${S.categories.map(c => `<li><a href="#/catalog/${c.slug}" class="${slug===c.slug?'on':''}">${esc(c.title)} <small>${countIn(c.slug)}</small></a></li>`).join('')}
          </ul>
        </div>
        <div>
          <h4>Цена, ₽</h4>
          <div class="price-row">
            <input type="number" id="f-min" placeholder="от" value="${min||''}">
            <input type="number" id="f-max" placeholder="до" value="${isFinite(max)?max:''}">
          </div>
          <button class="btn sm ghost" id="f-apply" style="margin-top:10px;width:100%">Применить</button>
        </div>
        ${brands.length>1?`<div>
          <h4>Бренд</h4>
          <ul>
            <li><a href="${link({brand:null})}" class="${brand?'':'on'}">Все бренды</a></li>
            ${brands.map(b => `<li><a href="${link({brand:b})}" class="${brand===b?'on':''}">${esc(b)}</a></li>`).join('')}
          </ul>
        </div>`:''}
        <div>
          <h4>Наличие</h4>
          <label class="check"><input type="checkbox" id="f-stock" ${onlyIn?'checked':''}> Только в наличии</label>
          <label class="check" style="margin-top:10px"><input type="checkbox" id="f-sale" ${badge==='sale'?'checked':''}> Со скидкой</label>
        </div>
      </aside>

      <section>
        <div class="toolbar">
          <span class="count">Показано ${list.length}</span>
          <select id="f-sort">
            <option value="pop"        ${sort==='pop'?'selected':''}>Сначала популярные</option>
            <option value="price_asc"  ${sort==='price_asc'?'selected':''}>Сначала дешёвые</option>
            <option value="price_desc" ${sort==='price_desc'?'selected':''}>Сначала дорогие</option>
            <option value="new"        ${sort==='new'?'selected':''}>Новинки</option>
            <option value="name"       ${sort==='name'?'selected':''}>По названию</option>
          </select>
        </div>
        ${list.length
          ? `<div class="grid">${list.map(cardHTML).join('')}</div>`
          : `<div class="empty"><b>Ничего не нашли</b>Попробуйте изменить фильтры или напишите нам в WhatsApp — привезём под заказ.</div>`}
      </section>
    </div>
  </div>`;

  $('#f-sort').onchange  = e => location.hash = link({ sort: e.target.value });
  $('#f-stock').onchange = e => location.hash = link({ stock: e.target.checked ? '1' : null });
  $('#f-sale').onchange  = e => location.hash = link({ badge: e.target.checked ? 'sale' : null });
  $('#f-apply').onclick  = () => location.hash = link({ min: $('#f-min').value, max: $('#f-max').value });
}

function plural(n, one, few, many){
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/* ------------------------------------------------------------ карточка */
function renderProduct(id){
  const p = S.products.find(x => String(x.id) === String(id));
  if (!p) return $('#app').innerHTML = '<div class="wrap empty"><b>Товар не найден</b>Возможно, он снят с продажи.</div>';

  const discount = p.oldPrice > p.price ? Math.round((1 - p.price/p.oldPrice)*100) : 0;
  const similar = S.products.filter(x => x.category === p.category && x.id !== p.id).slice(0,5);

  $('#app').innerHTML = `
  <div class="wrap">
    <div class="crumbs">
      <a href="#/">Главная</a> / <a href="#/catalog">Каталог</a> /
      <a href="#/catalog/${esc(p.category)}">${esc(catTitle(p.category))}</a>
    </div>

    <div class="product">
      <div>
        <div class="gallery-main" id="gal-main">${picture(p)}</div>
        ${p.images && p.images.length > 1 ? `<div class="thumbs">${p.images.map((src,i)=>
          `<button data-src="${esc(src)}" class="${i?'':'on'}"><img src="${esc(src)}" alt=""></button>`).join('')}</div>` : ''}
      </div>

      <div>
        <div class="p-brand">${esc(p.brand || 'Ноготок')}</div>
        <h1 class="p-title">${esc(p.title)}</h1>
        ${p.sku ? `<div class="p-sku">Артикул: ${esc(p.sku)}</div>` : ''}

        <div class="p-price-box">
          <span class="p-price ${discount?'':''}">${money(p.price)}</span>
          ${p.oldPrice > p.price ? `<span class="p-old">${money(p.oldPrice)}</span><span class="p-econ">выгода ${money(p.oldPrice-p.price)}</span>` : ''}
        </div>
        <div class="stock ${p.inStock?'':'no'}"><i></i>${p.inStock ? 'В наличии в магазине, Дербент' : 'Под заказ — уточним срок в WhatsApp'}</div>

        <div class="buy-row">
          <div class="qty">
            <button id="q-minus">−</button><span id="q-val">1</span><button id="q-plus">+</button>
          </div>
          <button class="btn" style="flex:1" id="p-add">В корзину</button>
        </div>
        <a class="btn wa wide" id="p-wa" target="_blank" rel="noopener" style="margin-bottom:26px">Спросить в WhatsApp</a>

        <div class="p-info">
          <div><b>Доставка</b><span>${esc(S.settings.deliveryText||'')}</span></div>
          <div><b>Оплата</b><span>${esc(S.settings.paymentText||'')}</span></div>
          <div><b>Самовывоз</b><span>${esc(S.settings.city||'')}, ${esc(S.settings.address||'')} · ${esc(S.settings.hours||'')}</span></div>
        </div>
      </div>
    </div>

    <div class="p-wrap">
      <div class="p-desc">
        ${p.description ? `<h3>Описание</h3><p>${esc(p.description)}</p>` : ''}
        ${p.specs && p.specs.length ? `<h3 style="margin-top:30px">Характеристики</h3>
          <table class="spec-table">${p.specs.map(s=>`<tr><td>${esc(s.k)}</td><td>${esc(s.v)}</td></tr>`).join('')}</table>` : ''}
      </div>
    </div>

    ${similar.length ? `<section class="section">
      <div class="section-head"><h2>Похожие товары</h2><a href="#/catalog/${esc(p.category)}">Вся категория</a></div>
      <div class="grid rail">${similar.map(cardHTML).join('')}</div>
    </section>` : ''}
  </div>`;

  let qty = 1;
  $('#q-minus').onclick = () => { qty = Math.max(1, qty-1); $('#q-val').textContent = qty; };
  $('#q-plus').onclick  = () => { qty = Math.min(999, qty+1); $('#q-val').textContent = qty; };
  $('#p-add').onclick   = () => { addToCart(p.id, qty); };
  $('#p-wa').href = waLink(`Здравствуйте! Интересует товар «${p.title}» (${money(p.price)}). Подскажите по наличию.`);
  $$('.thumbs button').forEach(b => b.onclick = () => {
    $('#gal-main').innerHTML = `<img src="${b.dataset.src}" alt="">`;
    $$('.thumbs button').forEach(x => x.classList.toggle('on', x === b));
  });
}

/* --------------------------------------------------- контакты / доставка */
function renderContacts(){
  const s = S.settings;
  $('#app').innerHTML = `
  <div class="wrap">
    <div class="crumbs"><a href="#/">Главная</a> / <span>Контакты</span></div>
    <h1 class="page-title">Контакты</h1>
    <div class="catalog" style="grid-template-columns:1fr 1fr">
      <div style="padding-top:20px">
        <div class="p-info" style="border:0;padding:0">
          <div><b>Адрес</b><span>${esc(s.city||'')}, ${esc(s.address||'')}</span></div>
          <div><b>Телефон</b><span><a href="tel:${esc((s.phone||'').replace(/[^\d+]/g,''))}">${esc(s.phone||'')}</a></span></div>
          <div><b>WhatsApp</b><span><a id="c-wa" target="_blank" rel="noopener">Написать в WhatsApp</a></span></div>
          <div><b>Режим работы</b><span>${esc(s.hours||'')}</span></div>
          <div><b>Чем занимаемся</b><span>${esc(s.tagline||'')}. Оснащаем салоны и обучаем мастеров.</span></div>
        </div>
        <a class="btn wa" id="c-wa2" target="_blank" rel="noopener" style="margin-top:26px">Написать в WhatsApp</a>
        <a class="btn ghost" href="${esc(s.mapLink||'#')}" target="_blank" rel="noopener" style="margin-top:26px;margin-left:8px">Открыть на карте</a>
      </div>
      <div style="background:var(--surface);border-radius:4px;padding:34px">
        <h3 style="font-size:20px;margin-bottom:14px">Оснащаем салоны под ключ</h3>
        <p style="color:var(--ink-2)">Напишите, какой кабинет открываете — маникюрный, косметологический или барбершоп.
        Составим список оборудования и расходников, посчитаем смету и привезём. Для салонов действуют отдельные цены.</p>
      </div>
    </div>
    ${uspHTML()}
  </div>`;
  const href = waLink('Здравствуйте! Хочу проконсультироваться по оборудованию.');
  $('#c-wa').href = href; $('#c-wa2').href = href;
}

function renderDelivery(){
  const s = S.settings;
  $('#app').innerHTML = `
  <div class="wrap">
    <div class="crumbs"><a href="#/">Главная</a> / <span>Доставка и оплата</span></div>
    <h1 class="page-title">Доставка и оплата</h1>
    <div class="page-sub" style="max-width:640px">Как оформить заказ: соберите корзину, заполните форму — заказ моментально уйдёт нам в WhatsApp, мы подтвердим наличие и сроки.</div>
    ${uspHTML()}
    <div class="section">
      <div class="section-head"><h2>Как это работает</h2></div>
      <div class="usp" style="padding-top:0">
        <div><b>1. Корзина</b><p>Добавьте товары из каталога, количество меняется прямо в корзине.</p></div>
        <div><b>2. Форма</b><p>Укажите ФИО, город и телефон. Комментарий — по желанию.</p></div>
        <div><b>3. WhatsApp</b><p>Нажмите «Отправить» — откроется чат с готовым текстом заказа.</p></div>
        <div><b>4. Подтверждение</b><p>Мы перезвоним ${esc(s.hours||'в рабочее время')} и согласуем доставку.</p></div>
      </div>
    </div>
  </div>`;
}

/* -------------------------------------------------------------- корзина */
function addToCart(id, qty = 1){
  const p = S.products.find(x => x.id === id);
  if (!p) return;
  const line = S.cart.find(i => i.id === id);
  if (line) line.qty = Math.min(999, line.qty + qty);
  else S.cart.push({ id, qty });
  saveCart(); updateCart(); toast(`«${p.title.slice(0,40)}…» в корзине`);
  openDrawer();
}

function setQty(id, qty){
  const line = S.cart.find(i => i.id === id);
  if (!line) return;
  line.qty = qty;
  if (line.qty < 1) S.cart = S.cart.filter(i => i.id !== id);
  saveCart(); updateCart();
}

const cartLines = () => S.cart
  .map(i => ({ ...i, product: S.products.find(p => p.id === i.id) }))
  .filter(i => i.product);

const cartTotal = () => cartLines().reduce((s,i) => s + i.product.price * i.qty, 0);

function updateCart(){
  const lines = cartLines();
  const count = lines.reduce((s,i) => s + i.qty, 0);
  $('#cart-count').textContent = count;
  $('#cart-count').classList.toggle('hidden', !count);
  $('#drawer-count').textContent = count ? `· ${count} ${plural(count,'товар','товара','товаров')}` : '';

  $('#cart-body').innerHTML = lines.length ? lines.map(i => `
    <div class="cart-line">
      <a href="#/product/${i.product.id}" class="pic">${picture(i.product)}</a>
      <div style="flex:1">
        <div class="br">${esc(i.product.brand||'')}</div>
        <a href="#/product/${i.product.id}"><div class="nm">${esc(i.product.title)}</div></a>
        <div style="font-weight:700">${money(i.product.price)} <span style="color:var(--muted);font-weight:400;font-size:12px">/ ${esc(i.product.unit||'шт')}</span></div>
        <div class="row">
          <div class="mini-qty">
            <button data-dec="${i.id}">−</button><span>${i.qty}</span><button data-inc="${i.id}">+</button>
          </div>
          <button class="rm" data-rm="${i.id}">Удалить</button>
        </div>
      </div>
    </div>`).join('')
    : `<div class="empty" style="padding:60px 0"><b>Корзина пуста</b>Загляните в каталог — там ${S.products.length} ${plural(S.products.length,'позиция','позиции','позиций')}.</div>`;

  const total = cartTotal();
  const free = +S.settings.freeDeliveryFrom || 0;
  $('#cart-foot').innerHTML = lines.length ? `
    <div class="sum-row"><span>Товары, ${count} шт</span><b>${money(total)}</b></div>
    ${free ? `<div class="sum-row"><span>Доставка по Дербенту</span><b>${total >= free ? 'бесплатно' : 'обсудим в чате'}</b></div>` : ''}
    <div class="sum-row total"><span>Итого</span><span>${money(total)}</span></div>
    <button class="btn wide" id="to-checkout">Оформить заказ</button>
    <div class="note">Заказ уйдёт в WhatsApp магазина. Оплата — при получении.</div>`
    : `<button class="btn wide ghost" id="go-catalog">Перейти в каталог</button>`;

  $$('[data-inc]').forEach(b => b.onclick = () => setQty(+b.dataset.inc, S.cart.find(i=>i.id===+b.dataset.inc).qty + 1));
  $$('[data-dec]').forEach(b => b.onclick = () => setQty(+b.dataset.dec, S.cart.find(i=>i.id===+b.dataset.dec).qty - 1));
  $$('[data-rm]').forEach(b  => b.onclick = () => setQty(+b.dataset.rm, 0));
  const co = $('#to-checkout'); if (co) co.onclick = openCheckout;
  const gc = $('#go-catalog');  if (gc) gc.onclick = () => { closeDrawer(); location.hash = '#/catalog'; };

  $$('[data-add]').forEach(b => {
    const line = S.cart.find(i => i.id === +b.dataset.add);
    b.classList.toggle('added', !!line);
    b.textContent = line ? 'В корзине · ' + line.qty + ' шт' : 'В корзину';
  });
}

/* ----------------------------------------------------------- оформление */
function openCheckout(){
  closeDrawer();
  const lines = cartLines();
  if (!lines.length) return;
  const saved = JSON.parse(localStorage.getItem('nogotok_client') || '{}');

  $('#modal').innerHTML = `
    <h3>Оформление заказа</h3>
    <p class="lead">${lines.length} ${plural(lines.length,'позиция','позиции','позиций')} на ${money(cartTotal())}. Заполните данные — заказ уйдёт в WhatsApp.</p>
    <form id="checkout-form" novalidate>
      <div class="field" id="fw-name">
        <label>ФИО *</label><input name="name" value="${esc(saved.name||'')}" placeholder="Магомедова Асият Руслановна">
        <div class="msg">Укажите фамилию и имя</div>
      </div>
      <div class="field" id="fw-city">
        <label>Город *</label><input name="city" value="${esc(saved.city||'Дербент')}" placeholder="Дербент">
        <div class="msg">Укажите город доставки</div>
      </div>
      <div class="field" id="fw-phone">
        <label>Номер телефона *</label><input name="phone" id="phone-input" inputmode="tel" value="${esc(saved.phone||'')}" placeholder="+7 (___) ___-__-__">
        <div class="msg">Введите номер полностью</div>
      </div>
      <div class="field">
        <label>Комментарий к заказу</label>
        <textarea name="comment" placeholder="Удобное время звонка, адрес, пожелания по доставке"></textarea>
      </div>
      <button class="btn wa wide" type="submit" id="submit-order">Отправить заказ в WhatsApp</button>
      <div class="note">Нажимая кнопку, вы соглашаетесь на обработку контактных данных для оформления заказа.</div>
    </form>`;
  openModal();

  const phone = $('#phone-input');
  phone.addEventListener('input', () => phone.value = maskPhone(phone.value));
  if (!phone.value) phone.value = '+7 ';

  $('#checkout-form').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const customer = {
      name: f.name.value.trim(),
      city: f.city.value.trim(),
      phone: f.phone.value.trim(),
      comment: f.comment.value.trim(),
    };
    let bad = false;
    const mark = (id, cond) => { $(id).classList.toggle('err', !cond); if (!cond) bad = true; };
    mark('#fw-name', customer.name.length >= 3);
    mark('#fw-city', customer.city.length >= 2);
    mark('#fw-phone', customer.phone.replace(/\D/g,'').length >= 11);
    if (bad) return;

    const btn = $('#submit-order');
    btn.disabled = true; btn.textContent = 'Готовим заказ…';
    try{
      localStorage.setItem('nogotok_client', JSON.stringify({ name:customer.name, city:customer.city, phone:customer.phone }));
    }catch(err){}
    const order = buildOrder(customer);
    showSuccess(order);
    S.cart = []; saveCart(); updateCart();
  };
}

function buildOrder(customer){
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const items = cartLines().map(i => ({
    title: i.product.title, price: i.product.price, qty: i.qty, sum: i.product.price * i.qty,
  }));
  return {
    number: `НГ-${pad(d.getDate())}${pad(d.getMonth()+1)}-${pad(d.getHours())}${pad(d.getMinutes())}`,
    createdAt: `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    customer, items, total: cartTotal(),
  };
}

function orderText(order){
  const s = S.settings;
  const lines = order.items.map((i,n) => `${n+1}. ${i.title} — ${i.qty} шт × ${money(i.price)} = ${money(i.sum)}`);
  const parts = [
    `Здравствуйте! Заказ с сайта «${s.shopName||'Ноготок'}» № ${order.number}`,
    '',
    ...lines,
    '',
    `Итого: ${money(order.total)}`,
    '',
    `ФИО: ${order.customer.name}`,
    `Город: ${order.customer.city}`,
    `Телефон: ${order.customer.phone}`,
  ];
  if (order.customer.comment) parts.push(`Комментарий: ${order.customer.comment}`);
  parts.push('', `Самовывоз: ${s.city||''}, ${s.address||''}`);
  return parts.join('\n');
}

function showSuccess(order){
  const href = waLink(orderText(order));
  $('#modal').innerHTML = `
    <div class="ok-icon">✓</div>
    <h3 style="text-align:center">Заказ № ${esc(order.number)} создан</h3>
    <p class="lead" style="text-align:center">Осталось отправить его нам в WhatsApp — текст уже готов, просто нажмите «Отправить» в чате.</p>
    <a class="btn wa wide" id="wa-go" href="${esc(href)}" target="_blank" rel="noopener">Открыть WhatsApp и отправить</a>
    <button class="btn ghost wide" style="margin-top:10px" id="modal-close2">Закрыть</button>
    <div class="note">Если чат не открылся, позвоните нам: ${esc(S.settings.phone||'')}</div>`;
  $('#modal-close2').onclick = closeModal;
  setTimeout(() => { try{ window.open(href, '_blank', 'noopener'); }catch(e){} }, 350);
}

function maskPhone(value){
  let d = value.replace(/\D/g,'');
  if (d.startsWith('8')) d = '7' + d.slice(1);
  if (!d.startsWith('7')) d = '7' + d;
  d = d.slice(0, 11);
  const p = d.slice(1);
  let out = '+7';
  if (p.length) out += ' (' + p.slice(0,3);
  if (p.length >= 3) out += ') ' + p.slice(3,6);
  if (p.length >= 6) out += '-' + p.slice(6,8);
  if (p.length >= 8) out += '-' + p.slice(8,10);
  return out;
}

/* ------------------------------------------------------------- UI-мелочи */
const openDrawer  = () => { $('#drawer').classList.add('open'); $('#drawer-back').classList.add('open'); };
const closeDrawer = () => { $('#drawer').classList.remove('open'); $('#drawer-back').classList.remove('open'); };
const openModal   = () => $('#modal-back').classList.add('open');
const closeModal  = () => $('#modal-back').classList.remove('open');
const closeMega   = () => $('#megamenu').classList.remove('open');

function toast(text){
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(window.__toast);
  window.__toast = setTimeout(() => t.classList.remove('show'), 2600);
}

document.addEventListener('click', e => {
  const add = e.target.closest('[data-add]');
  if (add){ e.preventDefault(); addToCart(+add.dataset.add); }
  if (e.target.closest('.megamenu-item')) closeMega();
});

$('#burger').onclick = () => $('#megamenu').classList.toggle('open');
$('#megamenu').onclick = e => { if (e.target.id === 'megamenu') closeMega(); };
$('#open-cart').onclick = openDrawer;
$('#close-cart').onclick = closeDrawer;
$('#drawer-back').onclick = closeDrawer;
$('#modal-back').onclick = e => { if (e.target.id === 'modal-back') closeModal(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape'){ closeDrawer(); closeModal(); closeMega(); } });
$('#search-form').onsubmit = e => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  location.hash = q ? '#/catalog?q=' + encodeURIComponent(q) : '#/catalog';
};

boot();
