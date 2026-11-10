const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const output = path.join(root, 'dist')
const testOutput = path.join(root, '.test-build')

function write(filename, content) {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, content)
}

function jsImports(text, tests = false) {
  return text.replace(/from (["'])(\.[^"']+)\1/g, (_match, quote, specifier) => {
    const extension = path.extname(specifier) ? '' : '.js'
    const target = tests ? '../../dist/shared/' + path.basename(specifier) + extension : specifier + extension
    return `from ${quote}${target}${quote}`
  })
}

// Canonical state types live in shared/. Claude's SDK needs their atom bindings inlined.
function stateDeclaration() {
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(path.join(root, 'claude/state.d.ts'))
  const declaration = file.statements.find(node => ts.isModuleDeclaration(node))
  const state = declaration.body.statements.find(node => ts.isInterfaceDeclaration(node))
  const plugin = state.members.find(node => node.name.text === 'window-todo')
  function inline(type, depth = 0, optional = false) {
    if (depth > 12) throw new Error('Recursive Claude state type')
    if (type.flags & ts.TypeFlags.StringLiteral) return JSON.stringify(type.value)
    if (type.flags & ts.TypeFlags.NumberLiteral) return String(type.value)
    if (type.flags & ts.TypeFlags.String) return 'string'
    if (type.flags & ts.TypeFlags.Number) return 'number'
    if (type.flags & ts.TypeFlags.Boolean) return 'boolean'
    if (type.flags & ts.TypeFlags.Null) return 'null'
    if (type.flags & ts.TypeFlags.BooleanLiteral) return type.intrinsicName
    if (type.isUnion()) {
      const members = type.types.filter(member => !optional || !(member.flags & ts.TypeFlags.Undefined))
      if (members.every(member => member.flags & ts.TypeFlags.BooleanLike)) return 'boolean'
      return members.map(member => inline(member, depth + 1)).join(' | ')
    }
    if (checker.isArrayType(type)) return `Array<${inline(checker.getTypeArguments(type)[0], depth + 1)}>`
    if (type.flags & ts.TypeFlags.Object) {
      return '{ ' + checker.getPropertiesOfType(type).map(property => {
        const isOptional = !!(property.flags & ts.SymbolFlags.Optional)
        const propertyType = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration || property.declarations[0])
        return `${JSON.stringify(property.name)}${isOptional ? '?' : ''}: ${inline(propertyType, depth + 1, isOptional)}`
      }).join('; ') + ' }'
    }
    throw new Error('Unsupported Claude state type: ' + checker.typeToString(type))
  }
  const schema = inline(checker.getTypeAtLocation(plugin.type))
  return `// Generated from shared types and Claude state bindings.\ndeclare module 'claude-code' { interface PluginState { 'window-todo': ${schema} } }\n`
}

function build() {
  // Only task-owned build directories are removed; source files and release metadata stay intact.
  fs.rmSync(output, { recursive: true, force: true })
  fs.rmSync(testOutput, { recursive: true, force: true })
  write(path.join(output, 'package.json'), '{"type":"module"}\n')
  write(path.join(testOutput, 'package.json'), '{"type":"module"}\n')
  for (const directory of ['shared', 'claude']) {
    for (const name of fs.readdirSync(path.join(root, directory))) {
      if (!/\.tsx?$/.test(name) || name.endsWith('.d.ts') || name.includes('.test.')) continue
      const tests = name.includes('.spec.')
      const input = fs.readFileSync(path.join(root, directory, name), 'utf8')
      const compiled = ts.transpileModule(input, {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' },
        fileName: name,
      }).outputText
      const destination = path.join(tests ? testOutput : output, directory, name.replace(/\.tsx?$/, '.js'))
      write(destination, jsImports(compiled, tests))
    }
  }
  write(path.join(output, 'claude/state.d.ts'), stateDeclaration())
  const hooks = JSON.parse(fs.readFileSync(path.join(root, 'claude/hooks.json'), 'utf8'))
  hooks.modules = hooks.modules.map(module => module.replace(/\.tsx?$/, '.js'))
  write(path.join(output, 'claude/hooks.json'), JSON.stringify(hooks, null, 2) + '\n')
  fs.mkdirSync(path.join(output, 'codex'), { recursive: true })
  for (const name of fs.readdirSync(path.join(root, 'codex'))) {
    if (name.endsWith('.cjs') && !name.includes('.spec.')) fs.copyFileSync(path.join(root, 'codex', name), path.join(output, 'codex', name))
  }
  fs.cpSync(path.join(root, 'codex/skills'), path.join(output, 'codex/skills'), { recursive: true })
  fs.copyFileSync(path.join(root, 'codex/mcp.json'), path.join(output, 'codex/mcp.json'))
  console.log('Built one shared ESM core and the Claude/Codex adapters in dist/.')
}

if (require.main === module) build()
module.exports = { build }
