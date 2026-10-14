const { readFileSync } = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const vm = require('node:vm')
const ts = require('typescript')

// Mock only Electron/native boundaries; execute the production source unchanged.
function loadSource(relativePath, mocks = {}) {
  const filename = path.resolve(__dirname, '..', relativePath)
  const source = readFileSync(filename, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  const nativeRequire = createRequire(filename)
  const localRequire = (name) => (Object.hasOwn(mocks, name) ? mocks[name] : nativeRequire(name))
  const module = { exports: {} }
  const run = vm.runInThisContext(
    '(function(exports, require, module, __filename, __dirname) {' + compiled + '\n})',
    { filename }
  )
  run(module.exports, localRequire, module, filename, path.dirname(filename))
  return module.exports
}
module.exports = { loadSource }
