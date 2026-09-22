// 护理沟通模拟训练 - 零依赖本地服务器（只用 Node 内置模块，无需 npm install）
// 作用：1) 提供静态文件  2) 把前端请求转发给 DeepSeek（避开浏览器 CORS 限制）
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (e) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ error: '请求体不是合法 JSON' })); return; }

      const { baseURL, apiKey, model, messages, temperature } = parsed || {};
      if (!apiKey) {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ error: '缺少 API Key，请在页面右上角"⚙ 设置"里填写并保存' }));
        return;
      }
      if (!Array.isArray(messages) || messages.length === 0) {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ error: 'messages 不能为空' }));
        return;
      }

      callLLM(baseURL, apiKey, model, messages, temperature, (err, content) => {
        res.setHeader('Content-Type', 'application/json');
        if (err) { res.writeHead(502); res.end(JSON.stringify({ error: String(err.message || err) })); return; }
        res.writeHead(200);
        res.end(JSON.stringify({ content }));
      });
    });
    return;
  }

  // 静态文件服务
  if (req.method === 'GET') {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
      res.writeHead(403, {'Content-Type':'text/plain; charset=utf-8'}); res.end('禁止访问'); return;
    }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); res.end('404 未找到'); return; }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream'});
      res.end(data);
    });
    return;
  }

  res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'});
  res.end('404 未找到');
});

function callLLM(baseURL, apiKey, model, messages, temperature, cb) {
  let base = String(baseURL || 'https://api.deepseek.com').replace(/\/+$/, '');
  let url;
  try {
    url = new URL(base + '/chat/completions');
  } catch (e) {
    cb(new Error('接口地址不合法：' + base));
    return;
  }

  const payload = JSON.stringify({
    model: model || 'deepseek-chat',
    messages,
    temperature: (temperature === undefined || temperature === null) ? 0.7 : temperature,
    stream: false
  });

  const lib = url.protocol === 'https:' ? https : http;
  const upstream = lib.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 120000
  }, (r) => {
    let data = '';
    r.on('data', c => data += c);
    r.on('end', () => {
      try {
        const j = JSON.parse(data);
        if (j.error) { cb(new Error(j.error.message || JSON.stringify(j.error))); return; }
        const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        cb(null, content == null ? '' : content);
      } catch (e) {
        cb(new Error('无法解析模型响应：' + data.slice(0, 300)));
      }
    });
  });

  upstream.on('timeout', () => upstream.destroy(new Error('请求超时（120 秒）')));
  upstream.on('error', err => cb(err));
  upstream.write(payload);
  upstream.end();
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请先关闭占用它的程序，或用 PORT=3001 node server.js 换端口`);
  } else {
    console.error('启动失败：', e.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('==============================================');
  console.log('  护理沟通模拟训练 · 演示版已启动');
  console.log(`  请在浏览器打开： http://localhost:${PORT}`);
  console.log('  然后点右上角「⚙ 设置」填入 DeepSeek API Key');
  console.log('==============================================');
});
