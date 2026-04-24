import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const url = process.argv[2] || 'http://localhost:3000';
const label = process.argv[3] ? `-${process.argv[3]}` : '';
const dir = './temporary screenshots';

if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const existing = fs.readdirSync(dir).filter(f => f.endsWith('.png'));
const nums = existing.map(f => parseInt(f.match(/(\d+)/)?.[1] || '0')).filter(n => !isNaN(n));
const next = nums.length ? Math.max(...nums) + 1 : 1;
const outPath = path.join(dir, `screenshot-${next}${label}.png`);
const absOut = path.resolve(outPath);

// Try puppeteer
const puppeteerScript = `
const puppeteer = require('puppeteer');
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  await p.goto(process.argv[2], { waitUntil: 'networkidle0', timeout: 20000 });
  await new Promise(r => setTimeout(r, 1500));
  await p.screenshot({ path: process.argv[3], fullPage: false });
  await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });
`;

const tmpScript = path.join(dir, '_ss.cjs');
fs.writeFileSync(tmpScript, puppeteerScript);

const result = spawnSync('node', [tmpScript, url, absOut], { timeout: 30000, encoding: 'utf8' });
fs.unlinkSync(tmpScript);

if (result.status === 0) {
  console.log(outPath);
} else {
  // Fallback: macOS screencapture
  spawnSync('open', ['-a', 'Safari', url]);
  spawnSync('sleep', ['3']);
  const sc = spawnSync('screencapture', ['-T', '2', absOut]);
  if (sc.status === 0) console.log(outPath);
  else { console.error('Screenshot unavailable'); process.exit(1); }
}
