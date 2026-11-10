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

function jsImports(text, directory, tests = false) {
  const factory = ts.factory
  const file = ts.createSourceFile('runtime.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const result = ts.transform(file, [context => {
    function literal(node) {
      if (!node || (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node))) return node
      if (!node.text.startsWith('.')) return node
      const extension = path.extname(node.text) ? '' : '.js'
      let target = node.text + extension
      if (tests) {
        const source = path.resolve(root, directory, node.text)
        const runtime = path.join(output, path.relative(root, source)) + extension
        target = path.relative(path.join(testOutput, directory), runtime).split(path.sep).join('/')
        if (!target.startsWith('.')) target = './' + target
      }
      return factory.createStringLiteral(target)
    }
    function visit(node) {
      if (ts.isImportDeclaration(node)) return factory.updateImportDeclaration(node, node.modifiers, node.importClause, literal(node.moduleSpecifier), node.attributes)
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) return factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, literal(node.moduleSpecifier), node.attributes)
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (ts.isTemplateExpression(node.arguments[0]) && node.arguments[0].head.text.startsWith('.')) throw new Error('Use a literal path for relative dynamic imports in runtime modules.')
        return factory.updateCallExpression(node, node.expression, node.typeArguments, [literal(node.arguments[0]), ...node.arguments.slice(1)])
      }
      return ts.visitEachChild(node, visit, context)
    }
    return node => ts.visitNode(node, visit)
  }])
  const rewritten = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(result.transformed[0])
  result.dispose()
  return rewritten
}

// Canonical state types live in shared/ and claude/state-schema.ts. Claude's SDK needs them
// inlined into one self-contained contract, claude/state.d.ts, which the manifest points at.
const stateContract = path.join(root, 'claude/state.d.ts')

function stateDeclaration(base = root) {
  const config = ts.readConfigFile(path.join(base, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, base)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(path.join(base, 'claude/state-schema.ts'))
  const binding = file.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'WindowTodoState')
  if (!binding) throw new Error('claude/state-schema.ts must export type WindowTodoState.')
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
    if (checker.isTupleType(type)) throw new Error('Tuple types are not supported in Claude atom schemas.')
    if (checker.isArrayType(type)) return `Array<${inline(checker.getTypeArguments(type)[0], depth + 1)}>`
    if (type.flags & ts.TypeFlags.Object) {
      if (checker.getIndexInfosOfType(type).length) throw new Error('Index signatures are not supported in Claude atom schemas.')
      if (type.getCallSignatures().length || type.getConstructSignatures().length) throw new Error('Callable types are not supported in Claude atom schemas.')
      return '{ ' + checker.getPropertiesOfType(type).map(property => {
        const isOptional = !!(property.flags & ts.SymbolFlags.Optional)
        const propertyType = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration || property.declarations[0])
        return `${JSON.stringify(property.name)}${isOptional ? '?' : ''}: ${inline(propertyType, depth + 1, isOptional)}`
      }).join('; ') + ' }'
    }
    throw new Error('Unsupported Claude state type: ' + checker.typeToString(type))
  }
  const schema = inline(checker.getTypeAtLocation(binding.type))
  const shared = program.getSourceFile(path.join(base, 'shared/types.ts'))
  const exports = shared.statements.filter(node => ts.isTypeAliasDeclaration(node)).map(node => `export type ${node.name.text} = ${inline(checker.getTypeAtLocation(node.type))};`).join('\n')
  return `// Generated by \`npm run build\` from shared/types.ts and claude/state-schema.ts. Do not edit by hand.\n${exports}\ndeclare module 'claude-code' { interface PluginState { 'window-todo': ${schema} } }\n`
}

function build() {
  // Only task-owned build directories are removed; source files and release metadata stay intact.
  fs.rmSync(output, { recursive: true, force: true })
  fs.rmSync(testOutput, { recursive: true, force: true })
  write(path.join(output, 'package.json'), '{"type":"module"}\n')
  write(path.join(testOutput, 'package.json'), '{"type":"module"}\n')
  // Claude loads its adapter from the TypeScript sources; only the shared core is compiled for Codex.
  for (const name of fs.readdirSync(path.join(root, 'shared'))) {
    if (!/\.ts$/.test(name) || name.endsWith('.d.ts')) continue
    const tests = name.includes('.spec.')
    const input = fs.readFileSync(path.join(root, 'shared', name), 'utf8')
    const compiled = ts.transpileModule(input, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      fileName: name,
    }).outputText
    write(path.join(tests ? testOutput : output, 'shared', name.replace(/\.ts$/, '.js')), jsImports(compiled, 'shared', tests))
  }
  write(stateContract, stateDeclaration())
  fs.mkdirSync(path.join(output, 'codex'), { recursive: true })
  for (const name of fs.readdirSync(path.join(root, 'codex'))) {
    if (name.endsWith('.cjs') && !name.includes('.spec.')) fs.copyFileSync(path.join(root, 'codex', name), path.join(output, 'codex', name))
  }
  fs.cpSync(path.join(root, 'codex/skills'), path.join(output, 'codex/skills'), { recursive: true })
  fs.copyFileSync(path.join(root, 'codex/mcp.json'), path.join(output, 'codex/mcp.json'))
  console.log('Built the shared ESM core and the Codex adapter in dist/ and the Claude state contract in claude/state.d.ts.')
}

if (require.main === module) build()
module.exports = { build, jsImports, stateDeclaration }
