// 开发辅助：在整个 app.asar 里按字符串搜索，告诉你是哪些文件包含它（并给出上下文片段）。
// 用途：DSH 的客户端包是压缩过的单文件，路径和内容都不知道在哪；先搜字符串定位文件，再
// 用 asar-extract.cjs 解出来细看。
// 不是插件代码，DSH 不会加载它。
//
// 用法：node dev/asar-grep.cjs "api-session/status" [--files-only]
const fs = require('fs');

const asarPath = process.env.DSH_ASAR || 'D:/DeepSeekHarness/resources/app.asar';
const needle = process.argv[2];
const filesOnly = process.argv.includes('--files-only');
if (!needle) {
  console.log('用法: node dev/asar-grep.cjs <要搜索的字符串> [--files-only]');
  process.exit(1);
}

const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(12);
const hbuf = Buffer.alloc(headerSize);
fs.readSync(fd, hbuf, 0, headerSize, 16);
const header = JSON.parse(hbuf.toString('utf8').replace(/\u0000+$/, ''));

// 用已知文件的首字节反推数据基址
const candidates = [8 + fs.readFileSync(asarPath).subarray(0, 16).readUInt32LE(4) || head.readUInt32LE(4), 16 + headerSize, 16 + Math.ceil(headerSize / 4) * 4];
let base = null;
for (const c of candidates) {
  const probe = probeFile(c);
  if (probe) {
    base = c;
    break;
  }
}
function probeFile(b) {
  let node = header;
  for (const part of ['dsh', 'package.json']) {
    if (!node.files || !node.files[part]) return false;
    node = node.files[part];
  }
  const buf = Buffer.alloc(1);
  fs.readSync(fd, buf, 0, 1, b + Number(node.offset));
  return buf[0] === 0x7b;
}
if (base === null) {
  console.error('无法确定数据基址');
  process.exit(1);
}

let hits = 0;
function walk(node, prefix) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walk(child, prefix + '/' + name);
    return;
  }
  if (!node.size) return;
  const path = prefix;
  try {
    const buf = Buffer.alloc(node.size);
    fs.readSync(fd, buf, 0, node.size, base + Number(node.offset));
    const text = buf.toString('utf8');
    const at = text.indexOf(needle);
    if (at === -1) return;
    hits += 1;
    console.log(path + '  (' + node.size + ' B)');
    if (!filesOnly) {
      const start = Math.max(0, at - 200);
      console.log('   …' + text.slice(start, at + 200).replace(/\n/g, '\\n') + '…');
    }
  } catch (error) {
    /* 跳过读不了的文件 */
  }
}

const started = Date.now();
walk(header, '');
console.log('---');
console.log('命中文件数：' + hits + '，用时 ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
