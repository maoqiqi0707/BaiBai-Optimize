/**
 * 极简打包脚本：把 src/ 下的模块按顺序拼成一个 index.js。
 * 用法：在本目录下执行 node build.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();

const files = [
  'src/monitor.js',
  'src/channels.js',
  'src/apply.js',
  'src/floatball.js',
  'src/panel.js',
  'src/index.js',
];
const chunks = [];

for (const file of files) {
  let code = await readFile(path.join(root, file), 'utf8');

  // 去掉 import 语句，拼接后共享作用域
  code = code.replace(/^\s*import[\s\S]*?from\s*['"][^'"]+['"];?\s*$/gm, '');
  code = code.replace(/^\s*import\s*['"][^'"]+['"];?\s*$/gm, '');

  // export function / const / let 前缀去掉
  code = code.replace(/^export\s+(async\s+)?function\s+/gm, '$1function ');
  code = code.replace(/^export\s+const\s+/gm, 'const ');
  code = code.replace(/^export\s+let\s+/gm, 'let ');

  chunks.push(`/* ===== ${file} ===== */\n${code.trim()}\n`);
}

const banner = `/*
 * 柏宝绘优化
 * 观察柏宝绘的请求与返回，诊断「没有返回可解析的 JSON 对象」这类失败。
 * 只观察，不改写请求、不修改设置、不动柏宝绘的任何文件。
 * 生成时间：${new Date().toISOString()}
 */
`;

const bundled = `${banner}(function () {\n'use strict';\n\n${chunks.join('\n')}\n})();\n`;

await writeFile(path.join(root, 'index.js'), bundled, 'utf8');
console.log(`已生成 index.js（${(bundled.length / 1024).toFixed(1)} KB）`);
