/**
 * 冒烟测试：不依赖 DSH / 浏览器 / 真实 React，用极简 React 替身跑通
 *   1) client.js 能否被 ModuleLoader 形式加载；
 *   2) factory 能否返回带 apply 的插件；
 *   3) apply 是否注册了预期的两个 slot；
 *   4) 两个组件能否在给定 props 下完成一次渲染（无异常、有预期文案）。
 *
 * 注意：这**不能**替代真实页面验证（真实 React/Lexical/DOM 行为仍需刷新页面后手测），
 * 只用于在没有安装插件、没有打开 DSH 的情况下抓住「模块/注册/渲染层」的低级错误。
 *
 * 运行：node test-smoke.mjs
 */
import fs from 'node:fs'
import assert from 'node:assert/strict'

// ---------- 极简 React 替身 ----------
function createFakeReact() {
  let hooks = []
  let cursor = 0
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) {
        hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      return [hooks[index].value, (next) => { hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next }]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    },
    useEffect() {
      cursor += 1
    },
    useMemo(factory) {
      return factory()
    },
    useCallback(fn) {
      return fn
    },
    memo(fn) {
      return fn
    },
  }
  function render(Component, props) {
    hooks = []
    cursor = 0
    return Component(props)
  }
  return { React, render }
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node.children) return textOf(node.children)
  return ''
}

// ---------- 极简 document / localStorage / window ----------
const appended = []
const fakeDocument = {
  activeElement: null,
  head: { appendChild(element) { appended.push(element) } },
  createElement() {
    return { dataset: {}, textContent: '', remove() {} }
  },
  addEventListener() {},
  removeEventListener() {},
  querySelector() { return null },
}
const memory = new Map()
const fakeLocalStorage = {
  getItem(key) { return memory.has(key) ? memory.get(key) : null },
  setItem(key, value) { memory.set(key, String(value)) },
  removeItem(key) { memory.delete(key) },
}
const fakeWindow = {
  __ModuleLoader__: null,
  setTimeout: () => 0,
  clearTimeout: () => {},
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener() {},
  removeEventListener() {},
  getSelection: () => null,
}
fakeWindow.__ModuleLoader__ = {
  load(definition) {
    fakeWindow.loaded = definition
  },
}

// ---------- 加载 client.js ----------
const source = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const fake = createFakeReact()
new Function('window', 'document', 'localStorage', 'navigator', 'console', source)(
  fakeWindow,
  fakeDocument,
  fakeLocalStorage,
  {},
  console,
)

const loaded = fakeWindow.loaded
assert.ok(loaded, 'window.__ModuleLoader__.load 没有被调用')
assert.equal(loaded.id, '@local/gloss')
assert.equal(typeof loaded.factory, 'function')

const plugin = loaded.factory((name) => {
  assert.equal(name, 'react')
  return fake.React
})
assert.ok(plugin && typeof plugin.apply === 'function', 'factory 没有返回插件对象')
assert.deepEqual(plugin.inject, ['slots'])

// ---------- apply：捕获 slot 注册 ----------
const registrations = []
const fakeCtx = {
  effect(callback) {
    const cleanup = callback()
    assert.equal(typeof cleanup, 'function', '样式 effect 应返回清理函数')
    return cleanup
  },
  slots: {
    inject(name, register) {
      register()
    },
    register(options, Component) {
      registrations.push({ options, Component })
      return () => {}
    },
  },
}
plugin.apply(fakeCtx)

const bySlot = new Map(registrations.map((entry) => [entry.options.name, entry]))
assert.equal(registrations.length, 2)
assert.ok(bySlot.has('shell.overlay'), '缺少 shell.overlay 注册')
assert.ok(bySlot.has('conversation.composer.dock'), '缺少 composer.dock 注册')
assert.equal(bySlot.get('conversation.composer.dock').options.id, 'gloss-dock')
assert.equal(typeof bySlot.get('shell.overlay').Component, 'function')
assert.equal(typeof bySlot.get('conversation.composer.dock').Component, 'function')

// 样式已挂到 document.head
assert.equal(appended.length, 1)
const styleTag = appended[0]
assert.match(styleTag.textContent, /--dsw-alias/, '样式应使用主题 token')
assert.match(styleTag.textContent, /\.rnx-dock/, '样式应包含托盘类名')

// ---------- 渲染 overlay：无选区时应渲染为 null ----------
const Overlay = bySlot.get('shell.overlay').Component
assert.equal(fake.render(Overlay, {}), null)

// ---------- 渲染 dock：带批注块时应渲染出计数 ----------
const BEGIN = '====== 批注（DSH 自动收集，请按编号逐条回应）======'
const END = '====== 批注结束 ======'
const block = [
  BEGIN,
  '1) 位置：第2轮回答',
  '   类型：问题',
  '   引用：厂商口径称补贴率为 12%',
  '   批注：这里的数字是官方口径还是第三方转述？',
  '2) 位置：第5轮回答',
  '   类型：想法',
  '   引用：可以按投入-产出-验证展开',
  '   批注：想套到我们自己的方案里',
  END,
].join('\n')
const dockDraft = '我自己的前言\n\n' + block + '\n\n我自己的后记'
const dockInput = { draft: dockDraft, phase: 'plain', occurrences: [], claim: undefined }
const Dock = bySlot.get('conversation.composer.dock').Component
const dockTree = fake.render(Dock, {
  sessionId: 'session-test',
  inputActions: { setDraft() {} },
  useInput: (selector) => {
    const [state] = fake.React.useState(dockInput)
    return selector ? selector(state) : state
  },
})
const dockText = textOf(dockTree)
assert.match(dockText, /批注 2 条/, '托盘应显示批注数量')
assert.match(dockText, /自动同步/, '托盘应显示自动同步开关')

// ---------- 渲染 dock：空草稿应保持不渲染 ----------
const emptyTree = fake.render(Dock, {
  sessionId: 'session-empty',
  inputActions: { setDraft() {} },
  useInput: (selector) => {
    const [state] = fake.React.useState({ draft: '', phase: 'plain', occurrences: [], claim: undefined })
    return selector ? selector(state) : state
  },
})
assert.equal(emptyTree, null, '空草稿无备份时托盘不应占位')

console.log('gloss 冒烟测试')
console.log('  ✓ ModuleLoader 载入 + factory 返回插件')
console.log('  ✓ apply 注册 shell.overlay / composer.dock')
console.log('  ✓ 样式 effect 使用主题 token 并返回清理函数')
console.log('  ✓ overlay 无选区渲染 null')
console.log('  ✓ dock 能从草稿解析出 2 条批注并渲染计数')
console.log('  ✓ dock 空草稿不渲染')
console.log('\n6 项通过（真实页面行为仍需安装后手测）')
