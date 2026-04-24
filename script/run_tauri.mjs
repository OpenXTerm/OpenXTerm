#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(scriptDir)
const [command, ...rawTauriArgs] = process.argv.slice(2)

if (!command || !['dev', 'build'].includes(command)) {
  console.error('Usage: node script/run_tauri.mjs <dev|build> [...tauri args]')
  process.exit(1)
}

const env = { ...process.env }
const tauriArgs = normalizeTauriArgs(command, rawTauriArgs, env)

if (process.platform === 'win32') {
  ensureWindowsPerl(env)
}

const tauriScript = join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
if (!existsSync(tauriScript)) {
  console.error('Tauri CLI was not found. Run `npm install` first.')
  process.exit(1)
}

const child = spawn(process.execPath, [tauriScript, command, ...tauriArgs], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

function ensureWindowsPerl(env) {
  if (usablePerlCommand('perl', env)) {
    return
  }

  const perlPath = findUsableWindowsPerl(env)
  if (perlPath) {
    const perlDir = dirname(perlPath)
    prependToPath(env, perlDir)
    console.log(`[OpenXTerm] Using Perl from ${perlDir} for vendored OpenSSL builds.`)
    return
  }

  console.error([
    'OpenXTerm needs Perl on Windows because libssh-rs builds vendored OpenSSL.',
    '',
    'Install one of these, then run the command again:',
    '  winget install StrawberryPerl.StrawberryPerl',
    '  choco install strawberryperl',
  ].join('\n'))
  process.exit(1)
}

function usablePerlCommand(executable, env) {
  const result = spawnSync(executable, ['-MIPC::Cmd', '-MLocale::Maketext::Simple', '-e', 'print "ok"'], {
    env,
    stdio: 'ignore',
    shell: false,
  })
  return result.status === 0
}

function findUsableWindowsPerl(env) {
  const candidates = [
    'C:\\Strawberry\\perl\\bin\\perl.exe',
    'C:\\Program Files\\Strawberry\\perl\\bin\\perl.exe',
    'C:\\Program Files (x86)\\Strawberry\\perl\\bin\\perl.exe',
    'C:\\Perl64\\bin\\perl.exe',
    'C:\\Perl\\bin\\perl.exe',
  ]

  return candidates.find((candidate) => existsSync(candidate) && usablePerlCommand(candidate, env)) ?? null
}

function prependToPath(env, directory) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path'
  env[pathKey] = `${directory}${delimiter}${env[pathKey] ?? ''}`
}

function normalizeTauriArgs(command, args, env) {
  const normalized = [...args]

  if (command === 'build' && !normalized.includes('--target')) {
    const npmTarget = env.npm_config_target
    if (npmTarget && !normalized.includes(npmTarget)) {
      normalized.unshift(npmTarget)
    }

    if (normalized[0] && looksLikeRustTargetTriple(normalized[0])) {
      normalized.unshift('--target')
    }
  }

  return normalized
}

function looksLikeRustTargetTriple(value) {
  return /^(x86_64|aarch64|armv7|i686)-[a-z0-9_]+-[a-z0-9_]+/.test(value)
}
