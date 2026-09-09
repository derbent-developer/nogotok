/**
 * Ноготок — серверная часть магазина на Cloudflare Workers.
 *
 * Задачи:
 *   1. Раздавать файлы сайта покупателям.
 *   2. Пускать хозяина в панель по паролю, единому для всех устройств.
 *   3. Самому ходить в GitHub с секретным ключом, чтобы ключ никогда
 *      не попадал в браузер.
 *
 * Секрет в настройках Cloudflare: GITHUB_TOKEN.
 * Пароль хранится хешем в файле data/auth.json закрытого репозитория.
 */

const GH = 'https://api.github.com';
const COOKIE = 'nogotok_session';
const SESSION_TTL = 12 * 60 * 60;          // 12 часов
const ITERATIONS = 200000;
const LOGIN_DELAY = 700;                    // тормозим перебор пароля
const MAX_FAILS = 12;                       // попыток за окно
const FAIL_WINDOW = 15 * 60 * 1000;

const HIDDEN = /^\/(worker\/|wrangler\.|\.assetsignore|\.gitignore|data\/auth\.json)/;

const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try{
      if (url.pathname.startsWith('/api/')) return await api(request, env, url);
      if (HIDDEN.test(url.pathname)) return new Response('Not found', { status: 404 });
    }catch(e){
      return json({ ok: false, error: e.message || 'Ошибка сервера' }, e.status || 500);
    }
    if (!env.ASSETS) return new Response('Сайт не настроен', { status: 500 });
    return env.ASSETS.fetch(request);
  },
};

/* ------------------------------------------------------------- маршруты */
async function api(request, env, url){
  const p = url.pathname;
  const m = request.method;
  if (!env.GITHUB_TOKEN) return json({ ok:false, error:'На сервере не задан секрет GITHUB_TOKEN' }, 503);

  if (p === '/api/session'  && m === 'GET')  return sessionInfo(request, env);
  if (p === '/api/login'    && m === 'POST') return login(request, env);
  if (p === '/api/logout'   && m === 'POST') return logout();
  if (p === '/api/setup'    && m === 'POST') return setup(request, env);
  if (p === '/api/password' && m === 'POST') return changePassword(request, env);
  if (p.startsWith('/api/gh/')) return proxy(request, env, p.slice('/api/gh'.length) + url.search);
  return json({ ok:false, error:'Метод не найден' }, 404);
}

/* ------------------------------------------------------------ утилиты */
function json(data, status = 200, headers = {}){
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers },
  });
}
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const bytesToB64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const b64ToBytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const b64url = bytes => bytesToB64(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64url = text => b64ToBytes(text.replace(/-/g,'+').replace(/_/g,'/'));

function sameBytes(a, b){
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const repo = env => ({
  owner:  env.REPO_OWNER  || 'derbent-developer',
  name:   env.REPO_NAME   || 'nogotok',
  branch: env.REPO_BRANCH || 'main',
});

/* ---------------------------------------------------------- GitHub API */
async function ghFetch(env, path, init = {}){
  return fetch(GH + path, {
    ...init,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + env.GITHUB_TOKEN,
      'User-Agent': 'nogotok-shop',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
}

/** Панели разрешено ходить только в свой репозиторий и узнавать, кто она. */
function allowedPath(env, path){
  const r = repo(env);
  if (path === '/user' || path.startsWith('/user?')) return true;
  return path.startsWith(`/repos/${r.owner}/${r.name}`);
}

async function proxy(request, env, path){
  await requireSession(request, env);
  if (!allowedPath(env, path)) throw fail('Этот запрос не разрешён', 403);
  const init = { method: request.method };
  if (!['GET','HEAD'].includes(request.method)) init.body = await request.text();
  const res = await ghFetch(env, path, init);
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json', 'Cache-Control':'no-store' },
  });
}

/* ------------------------------------------------------------- пароль */
async function hashPassword(password, saltB64){
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name:'PBKDF2', salt: b64ToBytes(saltB64), iterations: ITERATIONS, hash:'SHA-256' }, base, 256);
  return bytesToB64(bits);
}

async function readAuth(env){
  const r = repo(env);
  const res = await ghFetch(env, `/repos/${r.owner}/${r.name}/contents/data/auth.json?ref=${r.branch}&t=${Date.now()}`);
  if (res.status === 404) return null;
  if (!res.ok) throw fail('Не удалось прочитать настройки доступа', 502);
  const meta = await res.json();
  return { sha: meta.sha, data: JSON.parse(dec.decode(b64ToBytes(meta.content.replace(/\s/g,'')))) };
}

async function writeAuth(env, data, sha){
  const r = repo(env);
  const body = {
    message: 'Обновлён пароль панели [сайт]',
    content: bytesToB64(enc.encode(JSON.stringify(data, null, 2))),
    branch: r.branch,
  };
  if (sha) body.sha = sha;
  const res = await ghFetch(env, `/repos/${r.owner}/${r.name}/contents/data/auth.json`,
    { method:'PUT', body: JSON.stringify(body) });
  if (!res.ok) throw fail('Не удалось сохранить пароль', 502);
}

function checkPasswordShape(password){
  if (!/^\d{6,32}$/.test(password) && String(password).length < 8)
    throw fail('Пароль — не меньше 6 цифр или 8 любых знаков');
}

/* ------------------------------------------------------------- сессия */
async function sessionKey(env){
  return crypto.subtle.importKey('raw', enc.encode(env.GITHUB_TOKEN + '|nogotok-session-v1'),
    { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
}

async function makeSession(env){
  const payload = b64url(enc.encode(JSON.stringify({ exp: Math.floor(Date.now()/1000) + SESSION_TTL })));
  const sig = b64url(await crypto.subtle.sign('HMAC', await sessionKey(env), enc.encode(payload)));
  return `${payload}.${sig}`;
}

async function validSession(env, value){
  if (!value || !value.includes('.')) return false;
  const [payload, sig] = value.split('.');
  const expected = await crypto.subtle.sign('HMAC', await sessionKey(env), enc.encode(payload));
  if (!sameBytes(unb64url(sig), new Uint8Array(expected))) return false;
  try{
    const { exp } = JSON.parse(dec.decode(unb64url(payload)));
    return exp > Math.floor(Date.now()/1000);
  }catch(e){ return false; }
}

function cookieValue(request, name){
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')){
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

async function requireSession(request, env){
  if (!await validSession(env, cookieValue(request, COOKIE)))
    throw fail('Нужно войти в панель заново', 401);
}

const setCookie = value =>
  `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`;

/* ------------------------------------------------------------ действия */
async function sessionInfo(request, env){
  const auth = await readAuth(env);
  return json({
    ok: true,
    настроен: !!auth,
    ready: !!auth,
    signedIn: await validSession(env, cookieValue(request, COOKIE)),
  });
}

const fails = new Map();
function throttle(request){
  const ip = request.headers.get('CF-Connecting-IP') || 'нет';
  const now = Date.now();
  const item = fails.get(ip);
  if (item && now - item.at < FAIL_WINDOW && item.n >= MAX_FAILS)
    throw fail('Слишком много попыток. Подождите 15 минут.', 429);
  return {
    bad(){
      const cur = (item && now - item.at < FAIL_WINDOW) ? item : { n: 0, at: now };
      cur.n++; cur.at = now;
      fails.set(ip, cur);
    },
    good(){ fails.delete(ip); },
  };
}

async function login(request, env){
  const counter = throttle(request);
  const { password = '' } = await request.json().catch(() => ({}));
  const auth = await readAuth(env);
  if (!auth) throw fail('Пароль ещё не задан. Откройте первый запуск.', 409);
  await sleep(LOGIN_DELAY);
  const hash = await hashPassword(String(password), auth.data.salt);
  if (hash !== auth.data.hash){
    counter.bad();
    throw fail('Неверный пароль', 401);
  }
  counter.good();
  return json({ ok: true }, 200, { 'Set-Cookie': setCookie(await makeSession(env)) });
}

function logout(){
  return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` });
}

/** Первый запуск: пароль задаётся один раз, подтверждением служит ключ GitHub. */
async function setup(request, env){
  const counter = throttle(request);
  const { key = '', password = '' } = await request.json().catch(() => ({}));
  if (await readAuth(env)) throw fail('Пароль уже задан. Смените его в разделе «Безопасность».', 409);
  await sleep(LOGIN_DELAY);
  if (!sameBytes(enc.encode(String(key)), enc.encode(env.GITHUB_TOKEN))){
    counter.bad();
    throw fail('Ключ GitHub не совпадает с тем, что задан на сервере', 403);
  }
  counter.good();
  checkPasswordShape(password);
  const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  await writeAuth(env, {
    v: 1, salt, hash: await hashPassword(String(password), salt),
    iterations: ITERATIONS, updatedAt: new Date().toISOString(),
  });
  return json({ ok: true }, 200, { 'Set-Cookie': setCookie(await makeSession(env)) });
}

async function changePassword(request, env){
  await requireSession(request, env);
  const { current = '', next = '' } = await request.json().catch(() => ({}));
  const auth = await readAuth(env);
  if (!auth) throw fail('Пароль ещё не задан', 409);
  if (await hashPassword(String(current), auth.data.salt) !== auth.data.hash)
    throw fail('Текущий пароль неверный', 403);
  checkPasswordShape(next);
  const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  await writeAuth(env, {
    v: 1, salt, hash: await hashPassword(String(next), salt),
    iterations: ITERATIONS, updatedAt: new Date().toISOString(),
  }, auth.sha);
  return json({ ok: true }, 200, { 'Set-Cookie': setCookie(await makeSession(env)) });
}
