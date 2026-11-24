// 开发辅助：在一个大文件里按关键词找上下文（每条命中打印前后各 260 字符）。
// 用途：app.asar 解出来的客户端包是压缩过的单文件，用 grep 工具不好看行内上下文。
// 不是插件代码，DSH 不会加载它。
//
// 用法：node dev/ctx-grep.cjs <文件> <关键词...>
const fs = require('fs');

const file = process.argv[2];
const terms = process.argv.slice(3);
if (!file || terms.length === 0) {
  console.log('用法: node dev/ctx-grep.cjs <文件> <关键词...>');
  process.exit(1);
}

const src = fs.readFileSync(file, 'utf8');
for (const term of terms) {
  let index = -1;
  let hits = 0;
  while ((index = src.indexOf(term, index + 1)) !== -1 && hits < 6) {
    hits += 1;
    console.log('=== ' + term + ' @' + index + ' ===');
    console.log(src.slice(Math.max(0, index - 260), index + 260).replace(/\n/g, '\\n'));
  }
}
