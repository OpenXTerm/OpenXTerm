import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const stylesDirectory = path.resolve('src/styles')
const colorLiteralPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g
const violations = []
const definedVariables = new Set()
const referencedVariables = new Set()
const runtimeVariables = new Set([
  '--file-table-columns',
  '--sftp-table-columns',
])

for (const fileName of fs.readdirSync(stylesDirectory).filter((name) => name.endsWith('.css')).sort()) {
  const filePath = path.join(stylesDirectory, fileName)
  const source = fs.readFileSync(filePath, 'utf8')
  const lines = source.split(/\r?\n/)
  let rootDepth = 0
  let insideRoot = false

  for (const match of source.matchAll(/(--[\w-]+)\s*:/g)) {
    definedVariables.add(match[1])
  }
  for (const match of source.matchAll(/var\((--[\w-]+)/g)) {
    referencedVariables.add(match[1])
  }

  lines.forEach((line, index) => {
    if (!insideRoot && /^\s*:root\s*\{/.test(line)) {
      insideRoot = true
    }

    if (!insideRoot) {
      for (const match of line.matchAll(colorLiteralPattern)) {
        violations.push(`${path.relative(process.cwd(), filePath)}:${index + 1}: ${match[0]}`)
      }
    }

    if (insideRoot) {
      rootDepth += (line.match(/\{/g) ?? []).length
      rootDepth -= (line.match(/\}/g) ?? []).length
      if (rootDepth === 0) {
        insideRoot = false
      }
    }
  })
}

if (violations.length > 0) {
  console.error('Hardcoded CSS colors are only allowed in the :root token block:')
  console.error(violations.join('\n'))
  process.exit(1)
}

const missingVariables = [...referencedVariables]
  .filter((name) => !definedVariables.has(name) && !runtimeVariables.has(name))
  .sort()

if (missingVariables.length > 0) {
  console.error('CSS variables must be declared in stylesheets or registered as runtime variables:')
  console.error(missingVariables.join('\n'))
  process.exit(1)
}

console.log('CSS color token and variable checks passed.')
