// 开发辅助：列出 app.asar 里的全部文件路径，写到同目录的 asar-index.txt。
// 用途：查 DSH 自身某个包/文件叫什么名字，再用 asar-extract.cjs 把它解出来看。
// 不是插件代码，DSH 不会加载它（package.json 的 exports 也不暴露 dev/）。
//
// 用法：node dev/asar-index.cjs
const fs = require('fs');
const path = require('path');

const asarPath = process.env.DSH_ASAR || 'D:/DeepSeekHarness/resources/app.asar';
const outFile = path.join(__dirname, 'asar-index.txt');

const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(12);
const hbuf = Buffer.alloc(headerSize);
fs.readSync(fd, hbuf, 0, headerSize, 16);
const header = JSON.parse(hbuf.toString('utf8').replace(/\u0000+$/, ''));

const out = [];
function walk(node, prefix) {
  if (!node.files) return;
  for (const [name, child] of Object.entries(node.files)) {
    const p = prefix + '/' + name;
    if (child.files) walk(child, p);
    else out.push(p);
  }
}
walk(header, '');
fs.writeFileSync(outFile, out.join('\n'));
console.log('entries:', out.length, '->', outFile);
