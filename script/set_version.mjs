import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

const rawVersion = process.argv[2]?.trim();
const version = rawVersion?.replace(/^v/, '');

if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: npm run version:set -- <semver>');
  console.error('Example: npm run version:set -- 0.2.0');
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), 'utf8'));
}

function writeTextIfChanged(relativePath, nextSource) {
  const absolutePath = resolve(repoRoot, relativePath);
  const source = readFileSync(absolutePath, 'utf8');

  if (source !== nextSource) {
    writeFileSync(absolutePath, nextSource);
  }
}

function writeJson(relativePath, data) {
  writeTextIfChanged(relativePath, `${JSON.stringify(data, null, 2)}\n`);
}

function replaceInFile(relativePath, pattern, replacement) {
  const absolutePath = resolve(repoRoot, relativePath);
  const source = readFileSync(absolutePath, 'utf8');

  if (!pattern.test(source)) {
    console.error(`Could not update ${relativePath}`);
    process.exit(1);
  }

  const nextSource = source.replace(pattern, replacement);
  if (source !== nextSource) {
    writeFileSync(absolutePath, nextSource);
  }
}

const packageJson = readJson('package.json');
packageJson.version = version;
writeJson('package.json', packageJson);

const packageLock = readJson('package-lock.json');
packageLock.version = version;
if (packageLock.packages?.['']) {
  packageLock.packages[''].version = version;
}
writeJson('package-lock.json', packageLock);

const tauriConfig = readJson('src-tauri/tauri.conf.json');
tauriConfig.version = version;
writeJson('src-tauri/tauri.conf.json', tauriConfig);

replaceInFile('src-tauri/Cargo.toml', /(^version\s*=\s*")[^"]+(")/m, `$1${version}$2`);
replaceInFile(
  'src-tauri/Cargo.lock',
  /(\[\[package\]\]\r?\nname = "openxterm"\r?\nversion = ")[^"]+(")/,
  `$1${version}$2`,
);

console.log(`OpenXTerm version set to ${version}`);
