// 极简 .gitignore 风格匹配（纯逻辑，可在 Node 中测试）。
// 支持：
//   # 注释、空行
//   foo.txt      匹配任意层级同名文件/目录
//   /build       仅匹配根目录下的 build
//   build/       仅匹配名为 build 的目录
//   *.log        通配符 * ?（按 basename 匹配）
//   src/tmp/a    带路径分隔符时按相对路径匹配
// 不支持否定规则(!)与 **（保持简单可预测）。

export function parseIgnore(text) {
  const rules = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let pattern = line;
    const dirOnly = pattern.endsWith('/');
    if (dirOnly) pattern = pattern.slice(0, -1);
    const rootOnly = pattern.startsWith('/');
    if (rootOnly) pattern = pattern.slice(1);
    const hasSlash = pattern.includes('/');
    rules.push({ raw: line, pattern, dirOnly, rootOnly, hasSlash, re: globToRegExp(pattern) });
  }
  return rules;
}

function globToRegExp(pattern) {
  let out = '^';
  for (const ch of pattern) {
    if (ch === '*') out += '[^]*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('(^|/)' + out + '($|/)');
}

/**
 * 判断相对路径（POSIX 风格，根目录文件无前导 /）是否应跳过。
 * @param relPath 例如 'build/x.js'
 * @param kind 'file' | 'dir'
 */
export function isIgnored(relPath, kind, rules) {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  for (const rule of rules) {
    if (rule.dirOnly && kind !== 'dir') continue;
    if (rule.hasSlash || rule.rootOnly) {
      if (rule.re.test(relPath)) return rule.raw;
    } else if (rule.re.test(base)) {
      return rule.raw;
    }
  }
  return null;
}
