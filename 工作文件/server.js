/* 工作文件 · 静态服务器（零依赖，仅用 Node 核心模块）
   安全规则：
   1. 禁止目录列表
   2. 禁止访问隐藏文件/目录（. 开头）
   3. 禁止访问 tests 路径
   4. 路径归一化，防目录穿越 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf'
};

function safePath(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch (e) {
    return null;
  }
  if (p.includes('\0')) return null;
  // 规则 2/3：隐藏文件与 tests 一律拒绝
  const parts = p.split('/').filter(Boolean);
  if (parts.length === 0) return path.join(ROOT, 'index.html');
  for (const seg of parts) {
    if (seg === '.' || seg === '..') return null; // 穿越段
    if (seg.startsWith('.')) return null;      // 隐藏文件/目录
    if (seg === 'tests') return null;          // 测试目录
  }
  // 规则 4：归一化后必须仍在 ROOT 内
  const full = path.normalize(path.join(ROOT, ...parts));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

function notFound(res, msg) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg || '404 Not Found');
}

const server = http.createServer(function (req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  const u = new URL(req.url, 'http://localhost');
  const filePath = safePath(u.pathname);
  if (!filePath) {
    notFound(res);
    return;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    notFound(res);
    return;
  }

  // 规则 1：目录不列清单，只回 index.html（根目录）或 404
  if (stat.isDirectory()) {
    const isRoot = path.resolve(filePath) === path.resolve(ROOT);
    if (!isRoot) {
      notFound(res);
      return;
    }
    const indexFile = path.join(filePath, 'index.html');
    try {
      fs.accessSync(indexFile, fs.constants.R_OK);
      streamFile(indexFile, res);
    } catch (e) {
      notFound(res);
    }
    return;
  }

  streamFile(filePath, res);
});

function streamFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const stream = fs.createReadStream(filePath);
  stream.on('open', function () {
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    stream.pipe(res);
  });
  stream.on('error', function () {
    if (!res.headersSent) notFound(res);
    else res.end();
  });
}

server.listen(PORT, '0.0.0.0', function () {
  console.log('工作文件静态服务已启动，端口 ' + PORT);
});
