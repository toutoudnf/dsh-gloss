/**
 * 纯函数单测：从 client.js 里抽出「纯函数区」在 Node 里执行。
 *
 * 为什么能这么做：批注块的解析/生成/合并刻意做成了不依赖 React、DOM 的纯函数，
 * 整段代码可以脱离 DSH 运行。这样在没有安装插件、没有打开 DSH 页面的情况下，
 * 也能验证最核心的「块格式 ↔ 草稿」逻辑。
 *
 * 运行：node test-pure.mjs
 */
import fs from 'node:fs'
import assert from 'node:assert/strict'

const source = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const startMark = '// ===== 纯函数区'
const endMark = '// ===== /纯函数区 ====='
const start = source.indexOf(startMark)
const end = source.indexOf(endMark)
assert.ok(start >= 0 && end > start, 'client.js 里找不到纯函数区标记')

const body = source.slice(start, end)
const api = new Function(
  body +
    '\nreturn { BEGIN, END, MAX_QUOTE, MAX_NOTES, MAX_HEADING, TYPE_LABEL, truncate, basenameOf, toWorkspacePath,' +
    ' normalizeHeading, normalizeQuote, normalizeNote, locationLabelOf, formatBlock, parseBlock, mergeBlock,' +
    ' mergeNotes, sortNotes, blockSignature, stripRuntimeNote, cutBlock };',
)()

const { BEGIN, END, MAX_QUOTE, MAX_NOTES } = api
let passed = 0

function test(name, fn) {
  fn()
  passed += 1
  console.log('  ✓ ' + name)
}

console.log('gloss 纯函数单测')

test('格式 → 解析 roundtrip：轮次排序、类型、多行批注/引用', () => {
  const input = [
    {
      turn: 3,
      kindLabel: '回答',
      offset: 120,
      quote: '第三轮的引用',
      note: '第一行\n类型：这不是字段\n第三行',
      type: 'idea',
      createdAt: 3,
    },
    {
      turn: 2,
      kindLabel: '提问',
      offset: 40,
      quote: '第二轮的引用',
      note: '这是问题',
      type: 'question',
      createdAt: 1,
    },
  ]
  const block = api.formatBlock(input)
  assert.ok(block.startsWith(BEGIN))
  assert.ok(block.endsWith(END))
  const parsed = api.parseBlock('我的前言\n\n' + block + '\n\n我的补充')
  assert.equal(parsed.present, true)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.notes.length, 2)
  assert.equal(parsed.notes[0].turn, 2)
  assert.equal(parsed.notes[0].type, 'question')
  assert.equal(parsed.notes[0].quote, '第二轮的引用')
  assert.equal(parsed.notes[1].turn, 3)
  assert.equal(parsed.notes[1].type, 'idea')
  assert.equal(parsed.notes[1].note, '第一行\n类型：这不是字段\n第三行')
})

test('引用里出现结束标记也不会截断块', () => {
  const notes = [
    {
      turn: 1,
      kindLabel: '回答',
      quote: '这里提到 ' + END + ' 这个标记',
      note: '批注',
      type: 'question',
      createdAt: 1,
    },
  ]
  const parsed = api.parseBlock('前言\n\n' + api.formatBlock(notes) + '\n\n后记')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.notes.length, 1)
  assert.ok(parsed.notes[0].quote.includes('批注结束'))
})

test('批注行以 | 开头也能 roundtrip', () => {
  const notes = [
    { turn: 2, kindLabel: '回答', quote: '引用', note: '第一行\n|第二行', type: 'mark', createdAt: 1 },
  ]
  const parsed = api.parseBlock(api.formatBlock(notes))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.notes[0].note, '第一行\n|第二行')
})

test('未知轮次 roundtrip', () => {
  const parsed = api.parseBlock(api.formatBlock([
    { turn: null, kindLabel: '未知轮次', quote: '引用', note: '批注', type: 'mark', createdAt: 1 },
  ]))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.notes[0].turn, null)
})

test('草稿没有块：present=false', () => {
  const parsed = api.parseBlock('用户自己的草稿')
  assert.deepEqual(parsed, { present: false, ok: true, notes: [] })
})

test('坏块：present=true / ok=false', () => {
  const parsed = api.parseBlock(BEGIN + '\n随手乱写的一行\n' + END)
  assert.equal(parsed.present, true)
  assert.equal(parsed.ok, false)
})

test('mergeBlock：空草稿追加块', () => {
  const merged = api.mergeBlock('', [
    { turn: 1, kindLabel: '回答', quote: '引用', note: '批注', type: 'question', createdAt: 1 },
  ])
  assert.ok(merged.startsWith(BEGIN))
  assert.ok(merged.endsWith(END))
  assert.equal(api.parseBlock(merged).notes.length, 1)
})

test('mergeBlock：保留用户块外文字（前 + 后）', () => {
  const notes = [
    { turn: 1, kindLabel: '回答', quote: '引用', note: '批注', type: 'question', createdAt: 1 },
  ]
  const first = api.mergeBlock('用户前言', notes)
  assert.ok(first.startsWith('用户前言\n\n' + BEGIN))
  const second = api.mergeBlock(first, notes.concat([
    { turn: 2, kindLabel: '回答', quote: '引用2', note: '批注2', type: 'idea', createdAt: 2 },
  ]))
  assert.ok(second.startsWith('用户前言\n\n' + BEGIN))
  assert.equal(api.parseBlock(second).notes.length, 2)
  const third = api.mergeBlock(second + '\n\n用户后记', notes)
  assert.ok(third.endsWith('用户后记'))
  assert.equal(api.parseBlock(third).notes.length, 1)
})

test('mergeBlock：清空批注只移除块，保留用户文字', () => {
  const notes = [
    { turn: 1, kindLabel: '回答', quote: '引用', note: '批注', type: 'question', createdAt: 1 },
  ]
  const draft = '前\n\n' + api.formatBlock(notes) + '\n\n后'
  assert.equal(api.mergeBlock(draft, []), '前\n\n后')
  assert.equal(api.mergeBlock('', []), '')
})

test('mergeNotes：按轮次 + 轮内偏移排序', () => {
  const merged = api.mergeNotes(
    [{ turn: 5, offset: 10, quote: 'a', note: '', type: 'mark', createdAt: 9 }],
    [
      { turn: 2, offset: 90, quote: 'b', note: '', type: 'mark', createdAt: 8 },
      { turn: 2, offset: 10, quote: 'c', note: '', type: 'mark', createdAt: 7 },
      { turn: null, offset: null, quote: 'd', note: '', type: 'mark', createdAt: 6 },
    ],
  )
  assert.equal(merged.length, 4)
  assert.equal(merged[0].quote, 'c')
  assert.equal(merged[1].quote, 'b')
  assert.equal(merged[2].quote, 'a')
  assert.equal(merged[3].quote, 'd')
})

test('混合 offset：解析出的旧批注在同一轮内排在新批注之前', () => {
  const merged = api.mergeNotes(
    [
      { turn: 2, offset: null, quote: '已解析旧批注', note: '', type: 'mark', createdAt: 0 },
      { turn: 2, offset: null, quote: '已解析旧批注2', note: '', type: 'mark', createdAt: 0 },
    ],
    [{ turn: 2, offset: 3, quote: '新批注', note: '', type: 'mark', createdAt: Date.now() }],
  )
  assert.deepEqual(merged.map((note) => note.quote), ['已解析旧批注', '已解析旧批注2', '新批注'])
})

test('normalizeQuote：空白折叠 + 超长截断', () => {
  assert.equal(api.normalizeQuote('  a\n\t b  '), 'a b')
  const long = '字'.repeat(MAX_QUOTE + 10)
  const quote = api.normalizeQuote(long)
  assert.ok(quote.endsWith('…（已截断）'))
  assert.equal(Array.from(quote.slice(0, -'…（已截断）'.length)).length, MAX_QUOTE)
})

test('normalizeNote：保留换行、折叠空行、截断', () => {
  assert.equal(api.normalizeNote('  a  \n\n\n\n  b  '), 'a\n\nb')
  const long = '注'.repeat(5000)
  assert.ok(api.normalizeNote(long).endsWith('…（已截断）'))
})

test('formatBlock([]) 为空串', () => {
  assert.equal(api.formatBlock([]), '')
})

test('块签名随内容变化', () => {
  const a = [{ turn: 1, type: 'question', quote: 'q', note: 'n' }]
  const b = [{ turn: 1, type: 'question', quote: 'q', note: 'n2' }]
  assert.notEqual(api.blockSignature(a), api.blockSignature(b))
  assert.equal(api.blockSignature(a), api.blockSignature(a))
})

test('stripRuntimeNote 丢弃运行时字段', () => {
  const stripped = api.stripRuntimeNote({ id: 'p0', turn: 2, quote: 'q', note: 'n', type: 'idea', createdAt: 1, offset: 3 })
  assert.deepEqual(Object.keys(stripped).sort(), [
    'createdAt',
    'file',
    'heading',
    'kindLabel',
    'note',
    'offset',
    'quote',
    'turn',
    'type',
  ])
  assert.equal(stripped.id, undefined)
})

test('模拟完整批注流程：反复批注 → 草稿块 → 重新解析 → 清空', () => {
  let draft = '我自己的前言'
  const add = (turn, offset, quote, note, type) => {
    const pending = [{ turn, kindLabel: '回答', offset, quote, note, type, createdAt: draft.length }]
    const parsedBefore = api.parseBlock(draft)
    const existing = parsedBefore.present && parsedBefore.ok ? parsedBefore.notes : []
    draft = api.mergeBlock(draft, api.mergeNotes(existing, pending))
  }
  add(2, 10, '引用A', '问题A', 'question')
  add(5, 5, '引用B', '想法B', 'idea')
  add(2, 50, '引用C', '标记C', 'mark')
  const parsed = api.parseBlock(draft)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.notes.length, 3)
  assert.deepEqual(parsed.notes.map((note) => note.quote), ['引用A', '引用C', '引用B'])
  assert.ok(draft.startsWith('我自己的前言'))
  assert.ok(draft.includes('我自己的前言' + '\n\n' + BEGIN))
  // 用户按 Enter 后草稿被清空 → 托盘自然为空
  assert.equal(api.parseBlock('').present, false)
  // 手动清空批注：块移除、用户前言保留
  assert.equal(api.mergeBlock(draft, []), '我自己的前言')
})

test('文件批注：位置带路径与章节，roundtrip 保留', () => {
  const input = [
    {
      turn: null,
      kindLabel: '',
      heading: '已知限制',
      file: { path: '调研/2026-10-15-AI证书调研.md', label: '2026-10-15-AI证书调研.md' },
      quote: '厂商口径称补贴率为 12%',
      note: '这里的数字是官方口径还是第三方转述？',
      type: 'question',
      createdAt: 2,
    },
    {
      turn: 2,
      kindLabel: '回答',
      quote: '第二轮的引用',
      note: '聊天里的一条',
      type: 'idea',
      createdAt: 1,
    },
  ]
  const block = api.formatBlock(input)
  assert.ok(block.includes('位置：文件 调研/2026-10-15-AI证书调研.md'))
  assert.ok(block.includes('章节：已知限制'))
  const parsed = api.parseBlock(block)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.notes.length, 2)
  // 聊天批注（有轮次）排在文件批注（turn=null）之前
  assert.equal(parsed.notes[0].turn, 2)
  assert.equal(parsed.notes[0].file, null)
  assert.equal(parsed.notes[1].turn, null)
  assert.deepEqual(parsed.notes[1].file, {
    path: '调研/2026-10-15-AI证书调研.md',
    label: '2026-10-15-AI证书调研.md',
  })
  assert.equal(parsed.notes[1].heading, '已知限制')
  assert.equal(parsed.notes[1].quote, '厂商口径称补贴率为 12%')
})

test('旧格式批注块（只有轮次、无章节）仍能解析', () => {
  const legacy = [
    BEGIN,
    '1) 位置：第2轮回答',
    '   类型：问题',
    '   引用：旧引用',
    '   批注：旧批注',
    END,
  ].join('\n')
  const parsed = api.parseBlock(legacy)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.notes[0].turn, 2)
  assert.equal(parsed.notes[0].file, null)
  assert.equal(parsed.notes[0].heading, '')
})

test('文件位置：路径未知时降级为「文件（路径未知）」', () => {
  const block = api.formatBlock([
    {
      turn: null,
      kindLabel: '',
      file: { path: '', label: '文件预览' },
      quote: 'q',
      note: 'n',
      type: 'question',
      createdAt: 1,
    },
  ])
  assert.ok(block.includes('位置：文件（路径未知）'))
  const parsed = api.parseBlock(block)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.notes[0].file, null)
})

test('toWorkspacePath：工作区内转相对路径，区外原样返回', () => {
  assert.equal(api.toWorkspacePath('/ws/调研/a.md', '/ws'), '调研/a.md')
  assert.equal(api.toWorkspacePath('/ws', '/ws/'), '.')
  assert.equal(api.toWorkspacePath('/other/a.md', '/ws'), '/other/a.md')
  assert.equal(api.toWorkspacePath('/ws2/a.md', '/ws'), '/ws2/a.md')
  assert.equal(api.toWorkspacePath('', '/ws'), '')
})

test('basenameOf / normalizeHeading', () => {
  assert.equal(api.basenameOf('/ws/调研/a.md'), 'a.md')
  assert.equal(api.basenameOf('a.md'), 'a.md')
  assert.equal(api.basenameOf('/ws/调研/'), '调研')
  assert.equal(api.normalizeHeading('  已知   限制 '), '已知 限制')
  assert.equal(api.normalizeHeading(null), '')
})

test('blockSignature 区分文件路径与章节', () => {
  const base = {
    turn: null,
    type: 'question',
    quote: 'q',
    note: 'n',
    heading: 'A',
    file: { path: 'a.md', label: 'a.md' },
  }
  const other = { ...base, file: { path: 'b.md', label: 'b.md' } }
  const heading = { ...base, heading: 'B' }
  assert.notEqual(api.blockSignature([base]), api.blockSignature([other]))
  assert.notEqual(api.blockSignature([base]), api.blockSignature([heading]))
  assert.equal(api.blockSignature([base]), api.blockSignature([base]))
})

test('已知上限常量', () => {
  assert.equal(MAX_QUOTE, 800)
  assert.equal(MAX_NOTES, 20)
  assert.equal(api.MAX_NOTES, MAX_NOTES)
  assert.equal(api.MAX_HEADING, 60)
})

console.log('\n' + passed + ' 项通过')
