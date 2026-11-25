/* 自签证书生成（仅 https 模式用）
   证书只发给自己这台机器的内网 IP + localhost，私钥留在 .local-cert/ 下，不入库、不上传。
   换 WiFi 后 IP 变了会自动重签，旧证书直接覆盖。 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const forge = require('./vendor/forge');

const DIR = path.join(__dirname, '.local-cert');
const KEY = path.join(DIR, 'key.pem');
const CERT = path.join(DIR, 'cert.pem');
const DAYS = 3650;

function lanIps() {
  const out = [];
  try {
    const nets = os.networkInterfaces();
    Object.keys(nets).forEach(function (name) {
      (nets[name] || []).forEach(function (n) {
        if (n.family !== 'IPv4' || n.internal) return;
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address)) out.push(n.address);
      });
    });
  } catch (e) { /* 取不到就只用 127.0.0.1 */ }
  return Array.from(new Set(out)).sort();
}

function readPair() {
  try {
    return { key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) };
  } catch (e) {
    return null;
  }
}

function make() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16);
  cert.validity.notBefore = new Date(Date.now() - 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + DAYS * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: 'Dsearch LAN' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }];
  lanIps().forEach(function (ip) { altNames.push({ type: 7, ip: ip }); });
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: altNames }
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(KEY, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  fs.writeFileSync(CERT, forge.pki.certificateToPem(cert));
  return { key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT), ips: lanIps() };
}

function ensure() {
  const old = readPair();
  if (old) {
    try {
      const c = forge.pki.certificateFromPem(old.cert.toString('utf8'));
      const covered = lanIps().every(function (ip) {
        return (c.extensions.find(function (x) { return x.name === 'subjectAltName'; }) || { altNames: [] })
          .altNames.some(function (a) { return a.ip === ip; });
      });
      if (covered && c.validity.notAfter > new Date()) {
        return Object.assign(old, { ips: lanIps() });
      }
    } catch (e) { /* 解析失败就重签 */ }
  }
  return make();
}

module.exports = { ensure: ensure, lanIps: lanIps, DIR: DIR };
