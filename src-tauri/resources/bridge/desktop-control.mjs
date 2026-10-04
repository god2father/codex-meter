import { readFileSync } from 'node:fs';
import { isLoopback } from './network.mjs';

export function readDesktopChats(filename) {
  if (!filename) return [];
  const raw = readFileSync(filename);
  if (raw.length > 20000) throw new Error('Desktop chat list too large');
  const chats = JSON.parse(raw);
  if (!Array.isArray(chats) || chats.length > 100 || chats.some(chat =>
    !validDesktopTarget(chat.id) || typeof chat.title !== 'string' || !chat.title || chat.title.length > 200) ||
    new Set(chats.map(chat => chat.id)).size !== chats.length) throw new Error('Invalid desktop chat list');
  return chats.map(({ id, title }) => ({ id, title }));
}
export const validDesktopTarget = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);

// Browser access is local only, including when the device listener uses LAN TLS.
export function localDesktopRequest(req, config) {
  const scheme = config.lan ? 'https' : 'http';
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  const allowedHosts = names.map(name => `${name}:${config.port}`);
  if (config.port === (config.lan ? 443 : 80)) allowedHosts.push(...names);
  return isLoopback(req.socket.remoteAddress) && allowedHosts.includes(req.headers.host) &&
    (!req.headers.origin || req.headers.origin === `${scheme}://${req.headers.host}`);
}
const headers = type => ({ 'content-type': type, 'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Passport 聊天选择</title><link rel="stylesheet" href="/desktop.css"><main><h1>Passport 聊天选择</h1><p>设备跟随这里手动选定的聊天。桌面切换聊天不会自动改变设备目标。</p><form id="unlock"><label>Bridge 管理令牌<input id="token" type="password" autocomplete="off" required></label><button>加载聊天</button></form><form id="select" hidden><label>本机聊天<select id="chats"><option value="">选择聊天</option></select></label><label>或输入聊天 ID<input id="thread" maxlength="128" placeholder="聊天 UUID" autocomplete="off"></label><button>连接所选聊天</button><button id="clear" type="button">停止跟随</button></form><p id="status" role="status">尚未连接</p></main><script src="/desktop.js"></script></html>`;
const css = `:root{font-family:system-ui,sans-serif;color:#e8eaf0;background:#10141c}main{max-width:560px;margin:8vh auto;padding:24px}h1{font-size:28px}p{line-height:1.7;color:#b9c2d3}form{display:grid;gap:16px;margin:28px 0}label{display:grid;gap:8px}input,select,button{box-sizing:border-box;width:100%;padding:12px;border:1px solid #414d64;border-radius:8px;font:inherit;color:inherit;background:#1c2534}button{cursor:pointer;background:#244c80}button:disabled{opacity:.5;cursor:wait}[hidden]{display:none!important}`;
const script = `const token=document.querySelector('#token'),status=document.querySelector('#status'),form=document.querySelector('#select'),chats=document.querySelector('#chats'),thread=document.querySelector('#thread');
let busy=false;
async function request(path,body){const response=await fetch(path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token.value,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});if(!response.ok)throw new Error(response.status===403?'令牌无效或访问来源不允许':'操作失败，请检查桌面 IPC 连接');return response.json();}
function show(state){const match=[...chats.options].find(option=>option.value===state.threadId);status.textContent=state.threadId?'设备目标：'+(match?.textContent||state.threadId)+' · '+(state.connected?(state.synced?'已收到聊天快照':'等待聊天快照，请确认聊天已在桌面打开'):'桌面未连接，等待重连'):'未选择聊天，设备停止跟随';}
async function perform(action){if(busy)return;busy=true;document.querySelectorAll('button').forEach(button=>button.disabled=true);try{await action();}catch(error){status.textContent=error.message;}finally{busy=false;document.querySelectorAll('button').forEach(button=>button.disabled=false);}}
document.querySelector('#unlock').onsubmit=event=>{event.preventDefault();perform(async()=>{const state=await request('/desktop/state');chats.replaceChildren(new Option('选择聊天',''));state.chats.forEach(chat=>chats.add(new Option(chat.title,chat.id)));form.hidden=false;show(state);});};
chats.onchange=()=>{thread.value=chats.value;};form.onsubmit=event=>{event.preventDefault();perform(async()=>{const id=thread.value.trim();if(!id)throw new Error('请选择聊天或填写聊天 ID');show(await request('/desktop/select',{threadId:id}));});};document.querySelector('#clear').onclick=()=>perform(async()=>{show(await request('/desktop/select',{threadId:null}));});
setInterval(()=>{if(!form.hidden&&!busy)perform(async()=>show(await request('/desktop/state')));},2000);`;

export function desktopControl({ config, app, chats, askQuestion, getQuestion, getQuota = () => null }) {
  const state = () => ({ threadId: app.threadId, connected: !app.closed, synced: app.state !== undefined, chats, quota: getQuota() });
  return async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { res.writeHead(400); res.end('Invalid URL'); return true; }
    const endpoint = url.pathname;
    if (!['/desktop', '/desktop.css', '/desktop.js', '/desktop/state', '/desktop/select', '/desktop/question'].includes(endpoint)) return false;
    if (!localDesktopRequest(req, config)) { res.writeHead(403); res.end(); return true; }
    const asset = { '/desktop': [page, 'text/html; charset=utf-8'], '/desktop.css': [css, 'text/css'], '/desktop.js': [script, 'text/javascript'] }[endpoint];
    if (asset && req.method === 'GET') { res.writeHead(200, headers(asset[1])); res.end(asset[0]); return true; }
    if (req.headers.authorization !== `Bearer ${config.token}`) { res.writeHead(403); res.end(); return true; }
    try {
      let result;
      if (['/desktop/select', '/desktop/question'].includes(endpoint) && req.method === 'POST') {
        let body = ''; req.setEncoding('utf8');
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1024) throw new Error('Request too large'); }
        const input = JSON.parse(body);
        if (endpoint === '/desktop/select') {
          if (input.threadId !== null && !validDesktopTarget(input.threadId)) throw new Error('Invalid target');
          app.select(input.threadId);
        } else result = askQuestion(input.questions);
      } else if (endpoint === '/desktop/question' && req.method === 'GET') {
        result = getQuestion(url.searchParams.get('id'));
      } else if (endpoint !== '/desktop/state' || req.method !== 'GET') throw new Error('Unsupported action');
      res.writeHead(200, headers('application/json')); res.end(JSON.stringify(result ?? state()));
    } catch (error) { res.writeHead(error.statusCode === 404 ? 404 : 400); res.end('Invalid desktop request'); }
    return true;
  };
}
