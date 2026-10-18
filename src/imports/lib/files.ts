import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function readJsonIfExists<T = unknown>(file: string): T | undefined {
  return fs.existsSync(file) ? readJson<T>(file) : undefined;
}

/** Pretty JSON with trailing newline; only rewrites when content changed (keeps git diffs quiet). */
export function writeJson(file: string, value: unknown): boolean {
  ensureDir(path.dirname(file));
  const text = JSON.stringify(value, null, 2) + '\n';
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false;
  fs.writeFileSync(file, text);
  return true;
}

export function writeText(file: string, text: string): boolean {
  ensureDir(path.dirname(file));
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false;
  fs.writeFileSync(file, text);
  return true;
}
