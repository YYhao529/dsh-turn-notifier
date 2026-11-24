// 开发辅助：从 DSH 的 app.asar 里解出指定文件到 dev/out/（路径里的 / 换成 _）。
// 用途：想确认某个平台 API 到底怎么实现时，把对应源码解出来读；读完可以删。
// 不是插件代码，DSH 不会加载它。
//
// 用法：node dev/asar-extract.cjs /lib/main.js /package.json
const fs = require('fs');
const path = require('path');

const asarPath = process.env.DSH_ASAR || 'D:/DeepSeekHarness/resources/app.asar';
const outDir = path.join(__dirname, 'out');

const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(12);
const pickleSize = head.readUInt32LE(4);
const hbuf = Buffer.alloc(headerSize);
fs.readSync(fd, hbuf, 0, headerSize, 16);
const header = JSON.parse(hbuf.toString('utf8').replace(/\u0000+$/, ''));

// asar 头部有三种可能的对齐方式，用已知文件的首字节反推出真正的数据基址
const candidates = [8 + pickleSize, 16 + headerSize, 16 + Math.ceil(headerSize / 4) * 4];

function findNode(entryPath) {
  const parts = entryPath.split('/').filter(Boolean);
  let node = header;
  for (const p of parts) {
    if (!node.files || !node.files[p]) return null;
    node = node.files[p];
  }
  return node;
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.log('用法: node dev/asar-extract.cjs <asar 内路径...>');
  process.exit(1);
}
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

let base = null;
for (const c of candidates) {
  const n = findNode('/dsh/package.json');
  if (!n) break;
  const buf = Buffer.alloc(Math.min(64, n.size));
  fs.readSync(fd, buf, 0, buf.length, c + Number(n.offset));
  if (buf[0] === 0x7b) {
    base = c;
    break;
  }
}
console.log('dataBase:', base);
if (base == null) process.exit(1);

for (const t of targets) {
  const node = findNode(t);
  if (!node || !node.size) {
    console.log('MISSING', t);
    continue;
  }
  const buf = Buffer.alloc(node.size);
  fs.readSync(fd, buf, 0, node.size, base + Number(node.offset));
  const out = path.join(outDir, t.replace(/\//g, '_'));
  fs.writeFileSync(out, buf);
  console.log('OK', t, node.size, '->', out);
}
