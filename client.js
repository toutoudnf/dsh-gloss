/**
 * @local/gloss —— DSH Client 插件：多轮长对话中「划词攒批注、读完一次性提交」。
 *
 * 形态（设计说明见 docs/architecture.md）：
 *   - 纯 Client 插件，Host 半只有空 apply()；
 *   - `shell.overlay`：监听选区 → 浮标「＋批注」→ 批注输入浮层；
 *   - `conversation.composer.dock`：批注托盘，负责把批注写进输入框草稿；
 *   - 事实源 = 输入框草稿里的批注块（DSH 自己持久化草稿，发送即 user message，
 *     发送失败自动恢复草稿，所以托盘只是草稿的解析视图，不双写）。
 *
 * 约定：
 *   - 通过 window.__ModuleLoader__.load 注册惰性 factory，id 必须等于包名；
 *   - React 从模块表 require('react')，不自带 React；
 *   - 不 import 任何 @deepseek-ai/dsh-client-ui-* 包；样式只用宿主主题 token；
 *   - 宿主聊天行的两个 DOM 位置属性（data-chat-turn / data-chat-flow-kind）只用于
 *     「轮次号 + 跳转」，取不到时降级，不影响批注保存。
 */
window.__ModuleLoader__.load({
  id: '@local/gloss',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ===== 纯函数区（与 UI / DOM 解耦；test-pure.mjs 会整段抽取做单测）=====
    const BEGIN = '====== 批注（DSH 自动收集，请按编号逐条回应）======'
    const END = '====== 批注结束 ======'
    const MAX_QUOTE = 800
    const MAX_NOTE = 4000
    const MAX_NOTES = 20
    const BACKUP_PREFIX = 'dsh.gloss.backup.v1.'
    const AUTO_KEY = 'dsh.gloss.auto-sync.v1'
    const TYPE_LABEL = { question: '问题', idea: '想法', mark: '标记' }

    /** 截断到 max 个 code point，超出加标记。 */
    function truncate(text, max) {
      const chars = Array.from(String(text == null ? '' : text))
      if (chars.length <= max) return chars.join('')
      return chars.slice(0, max).join('') + '…（已截断）'
    }

    /** 引用：空白折叠成单行 + 截断。 */
    function normalizeQuote(text) {
      return truncate(String(text == null ? '' : text).replace(/\s+/g, ' ').trim(), MAX_QUOTE)
    }

    /** 批注正文：保留换行，逐行去首尾空白，折叠连续空行，截断。 */
    function normalizeNote(text) {
      const lines = String(text == null ? '' : text)
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      while (lines.length > 0 && lines[0] === '') lines.shift()
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      const out = []
      for (const line of lines) {
        if (line === '' && out[out.length - 1] === '') continue
        out.push(line)
      }
      return truncate(out.join('\n'), MAX_NOTE)
    }

    function typeFromLabel(label) {
      const text = String(label == null ? '' : label).trim()
      if (text === TYPE_LABEL.idea) return 'idea'
      if (text === TYPE_LABEL.mark) return 'mark'
      return 'question'
    }

    function parseLocation(text) {
      const value = String(text == null ? '' : text).trim()
      const match = /^第(\d+)轮(.*)$/.exec(value)
      if (match) return { turn: Number(match[1]), kindLabel: match[2].trim() || '回答' }
      return { turn: null, kindLabel: value || '未知轮次' }
    }

    /** 追加一行字段；多行内容用「   |」续行，避免和字段名冲突。 */
    function pushField(lines, name, value) {
      const parts = String(value == null ? '' : value).split('\n')
      lines.push('   ' + name + '：' + (parts[0] || ''))
      for (let index = 1; index < parts.length; index += 1) {
        lines.push('   |' + parts[index])
      }
    }

    /** 批注数组 → 给模型看的批注块；空数组返回 ''。 */
    function formatBlock(notes) {
      const sorted = sortNotes(notes)
      if (sorted.length === 0) return ''
      const lines = [BEGIN]
      sorted.forEach((note, index) => {
        const turnLabel = note.turn == null ? '未知轮次' : '第' + note.turn + '轮' + (note.kindLabel || '回答')
        lines.push(String(index + 1) + ') 位置：' + turnLabel)
        lines.push('   类型：' + (TYPE_LABEL[note.type] || TYPE_LABEL.question))
        pushField(lines, '引用', note.quote ? note.quote : '（未取到原文）')
        pushField(lines, '批注', note.note ? note.note : '（仅标记，暂未填写想法）')
      })
      lines.push(END)
      return lines.join('\n')
    }

    /** 从草稿里切出批注块（找不到返回 null）。 */
    function cutBlock(draft) {
      const text = String(draft == null ? '' : draft)
      const start = text.indexOf(BEGIN)
      if (start < 0) return null
      // 用 lastIndexOf：引用原文里即使出现 END 字样，也不会把块提前截断。
      const end = text.lastIndexOf(END)
      if (end < start) return { before: text.slice(0, start), block: '', after: '' }
      return {
        before: text.slice(0, start),
        block: text.slice(start, end + END.length),
        after: text.slice(end + END.length),
      }
    }

    /** 草稿 → { present, ok, notes }；present=false 表示草稿里没有块。 */
    function parseBlock(draft) {
      const text = String(draft == null ? '' : draft)
      const start = text.indexOf(BEGIN)
      if (start < 0) return { present: false, ok: true, notes: [] }
      const end = text.lastIndexOf(END)
      if (end < start) return { present: true, ok: false, notes: [] }
      const inner = text.slice(start + BEGIN.length, end)
      const notes = []
      let current = null
      let lastField = null
      const failed = { present: true, ok: false, notes: [] }
      for (const raw of inner.split('\n')) {
        const line = raw.trim()
        if (line === '') continue
        const item = /^(\d+)\)\s*位置：(.*)$/.exec(line)
        if (item) {
          const location = parseLocation(item[2])
          current = {
            turn: location.turn,
            kindLabel: location.kindLabel,
            type: 'question',
            quote: '',
            note: '',
          }
          notes.push(current)
          lastField = null
          continue
        }
        const field = /^(类型|引用|批注)：(.*)$/.exec(line)
        if (field && current !== null) {
          if (field[1] === '类型') {
            current.type = typeFromLabel(field[2])
            lastField = null
          } else if (field[1] === '引用') {
            current.quote = field[2]
            lastField = 'quote'
          } else {
            current.note = field[2]
            lastField = 'note'
          }
          continue
        }
        if (current !== null && lastField !== null && line.charAt(0) === '|') {
          const continuation = line.slice(1)
          if (lastField === 'quote') current.quote += '\n' + continuation
          else current.note += '\n' + continuation
          continue
        }
        return failed
      }
      if (notes.length === 0) return failed
      notes.forEach((note, index) => {
        note.id = 'p' + index
      })
      return { present: true, ok: true, notes }
    }

    /**
     * 按「轮次 → 轮内偏移 → 创建时间」排序（未知轮次排最后）。
     *
     * 注意：块格式不持久化 offset（模型不需要），所以从草稿解析出的批注 offset 为 null。
     * 此时同一轮内不做位置猜测，按 createdAt 排——解析出的旧批注 createdAt=0 在前，
     * 新加的批注在后，即「刷新后新增的批注排在该轮已有批注之后」。
     */
    function sortNotes(notes) {
      return [...(notes || [])].sort((left, right) => {
        const leftTurn = left.turn == null ? Infinity : left.turn
        const rightTurn = right.turn == null ? Infinity : right.turn
        if (leftTurn !== rightTurn) return leftTurn - rightTurn
        const leftOffset = Number.isFinite(left.offset) ? left.offset : null
        const rightOffset = Number.isFinite(right.offset) ? right.offset : null
        if (leftOffset !== null && rightOffset !== null && leftOffset !== rightOffset) {
          return leftOffset - rightOffset
        }
        return (left.createdAt || 0) - (right.createdAt || 0)
      })
    }

    /** 合并两组批注并排序（不做上限裁剪，上限由调用方检查）。 */
    function mergeNotes(existing, added) {
      return sortNotes([...(existing || []), ...(added || [])])
    }

    /** 只替换草稿里的批注块，块外用户文字原样保留。 */
    function mergeBlock(draft, notes) {
      const text = String(draft == null ? '' : draft)
      const sorted = sortNotes(notes)
      const block = sorted.length === 0 ? '' : formatBlock(sorted)
      const cut = cutBlock(text)
      if (cut === null) {
        return [text.replace(/\s+$/, ''), block].filter((part) => part !== '').join('\n\n')
      }
      return [cut.before.replace(/\s+$/, ''), block, cut.after.replace(/^\s+/, '')]
        .filter((part) => part !== '')
        .join('\n\n')
    }

    /** 备份用签名：只在批注内容变化时写 localStorage。 */
    function blockSignature(notes) {
      return (notes || [])
        .map((note) => [note.turn, note.type, note.quote, note.note].join('\u0001'))
        .join('\u0002')
    }

    /** 备份里只存可重建的数据，不存 React/运行时 id。 */
    function stripRuntimeNote(note) {
      return {
        turn: note.turn == null ? null : note.turn,
        kindLabel: note.kindLabel || '回答',
        offset: note.offset == null ? null : note.offset,
        quote: note.quote || '',
        note: note.note || '',
        type: note.type || 'question',
        createdAt: note.createdAt || 0,
      }
    }
    // ===== /纯函数区 =====

    // ===== 模块级 store：跨 overlay / dock 的「待同步批注」队列 =====
    // pending 是「还没成功写进草稿」的批注（例如输入框正在跑斜杠命令时）。
    // 一旦写进草稿，就以草稿为准，pending 清空。
    const store = {
      sessionId: null,
      notesCount: 0,
      pending: [],
      listeners: new Set(),
      subscribe(listener) {
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      },
      emit() {
        for (const listener of [...store.listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('[gloss] store listener failed', error)
          }
        }
      },
      pendingFor(sessionId) {
        return store.pending.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.note)
      },
      pendingCount() {
        return store.pending.length
      },
      addNote(sessionId, note) {
        store.pending.push({ sessionId, note })
        store.emit()
      },
      takePending(sessionId) {
        const mine = store.pendingFor(sessionId)
        store.pending = store.pending.filter((entry) => entry.sessionId !== sessionId)
        return mine
      },
      putBack(sessionId, notes) {
        for (const note of notes) store.pending.push({ sessionId, note })
        store.emit()
      },
    }

    /** 订阅 store 的轻量 hook（React 18，无外部依赖）。 */
    function useStoreTick() {
      const [, setTick] = React.useState(0)
      React.useEffect(() => store.subscribe(() => setTick((tick) => tick + 1)), [])
      return store
    }

    /** 输入框是否可安全写入；返回 null 表示可写，否则返回原因。 */
    function writeBlockedReason(input) {
      if (input === undefined || input === null) return '输入框尚未就绪'
      if (input.phase === 'submitting' || input.phase === 'adjudicating') return '输入框正在发送，稍后再试'
      if (input.claim !== undefined || input.phase === 'claimed') return '输入框里有斜杠命令，先处理命令'
      if (input.phase !== 'plain') return '输入框当前不可写'
      if (Array.isArray(input.occurrences) && input.occurrences.length > 0) {
        // setDraft 是整段纯文本重写，会丢掉 @ 引用 chip；宁可拒绝也不悄悄破坏用户草稿。
        return '输入框里有 @ 引用/文件，自动写入会丢失引用；请先清空引用再合并'
      }
      const active = typeof document !== 'undefined' ? document.activeElement : null
      if (active && typeof active.closest === 'function' && active.closest('[contenteditable="true"]')) {
        return '正在编辑输入框，先点一下别处再合并'
      }
      return null
    }

    function errorMessage(error) {
      if (error && typeof error.message === 'string') return error.message
      return String(error)
    }

    /** 从聊天行里取「轮次号 + 轮内偏移 + flow kind」，取不到就返回 null。 */
    function anchorOf(element) {
      const turnElement = element && typeof element.closest === 'function' ? element.closest('[data-chat-turn]') : null
      if (!turnElement) return { turn: null, kindLabel: '回答', offset: null }
      const turn = Number(turnElement.dataset.chatTurn)
      const kind = turnElement.dataset.chatFlowKind || ''
      return {
        turn: Number.isSafeInteger(turn) ? turn : null,
        kindLabel: kind === 'user' || kind === 'steering' ? '提问' : '回答',
        offset: null,
      }
    }

    /** 节点所在元素（文本节点取父元素）。 */
    function elementOfNode(node) {
      if (!node) return null
      return node.nodeType === 1 ? node : node.parentElement || null
    }

    /** 节点落在聊天 flow 内（且不在输入框/插件自身 UI 里）？是则返回元素。 */
    function flowElementOf(node) {
      const element = elementOfNode(node)
      if (!element || typeof element.closest !== 'function') return null
      if (element.closest('input, textarea, [contenteditable="true"], [data-rnx-ui]')) return null
      const flow =
        element.closest('[data-slot="conversation.chat.flow"]') ||
        element.closest('[data-conversation-scroll]')
      return flow ? element : null
    }

    /**
     * 选区锚点元素：优先用选区**起点**，其次终点，最后公共祖先。
     *
     * 为什么起点优先：用户从消息末尾往下拖到消息外（动作行/下一条）时，公共祖先会落到
     * flow 容器上——它没有 data-chat-turn，轮次号就丢了（实测会显示「未知轮次」）；
     * 而起点仍在消息内，能正确拿到所在轮。
     */
    function selectionElement(range) {
      return (
        flowElementOf(range.startContainer) ||
        flowElementOf(range.endContainer) ||
        flowElementOf(range.commonAncestorContainer)
      )
    }

    /** 计算选中文字在所属轮次内的字符偏移（失败返回 null）。 */
    function offsetWithin(range, element) {
      const turnElement = element.closest('[data-chat-turn]')
      if (!turnElement) return null
      try {
        const before = document.createRange()
        before.selectNodeContents(turnElement)
        before.setEnd(range.startContainer, range.startOffset)
        return before.toString().length
      } catch (error) {
        return null
      }
    }

    // ===== 选区浮标 + 批注输入浮层（root 覆盖层）=====
    function GlossOverlay() {
      const [selection, setSelection] = React.useState(null)
      const [editor, setEditor] = React.useState(null)
      const [type, setType] = React.useState('question')
      const [text, setText] = React.useState('')
      const [error, setError] = React.useState('')
      const [saved, setSaved] = React.useState('')
      const editorRef = React.useRef(null)
      const textareaRef = React.useRef(null)
      const selectionRef = React.useRef(null)
      const savedTimer = React.useRef(0)
      useStoreTick()

      React.useEffect(
        () => () => {
          window.clearTimeout(savedTimer.current)
        },
        [],
      )

      // 记住最新 editor 状态，供全局监听器判断
      React.useEffect(() => {
        editorRef.current = editor
      }, [editor])

      // 选区监听：去抖 → 过滤 → 记录快照
      React.useEffect(() => {
        let timer = 0
        const clear = () => {
          setSelection(null)
          selectionRef.current = null
        }
        const read = () => {
          if (editorRef.current) return
          const browserSelection = window.getSelection()
          if (!browserSelection || browserSelection.isCollapsed || browserSelection.rangeCount === 0) {
            clear()
            return
          }
          const range = browserSelection.getRangeAt(0)
          const element = selectionElement(range)
          if (!element) {
            clear()
            return
          }
          const quote = range.toString()
          if (!quote || !quote.trim()) {
            clear()
            return
          }
          const rect = range.getBoundingClientRect()
          if (!rect || (rect.width === 0 && rect.height === 0)) {
            clear()
            return
          }
          const snapshot = {
            text: quote,
            rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
            kind: element.closest('[data-chat-flow-kind]')
              ? element.closest('[data-chat-flow-kind]').dataset.chatFlowKind
              : null,
            ...anchorOf(element),
            offset: offsetWithin(range, element),
          }
          selectionRef.current = snapshot
          setSelection(snapshot)
        }
        const onSelectionChange = () => {
          window.clearTimeout(timer)
          timer = window.setTimeout(read, 120)
        }
        const hide = () => {
          clear()
        }
        document.addEventListener('selectionchange', onSelectionChange)
        window.addEventListener('scroll', hide, true)
        window.addEventListener('resize', hide)
        return () => {
          window.clearTimeout(timer)
          document.removeEventListener('selectionchange', onSelectionChange)
          window.removeEventListener('scroll', hide, true)
          window.removeEventListener('resize', hide)
        }
      }, [])

      // 编辑浮层打开后：聚焦输入框；点外部关闭；Esc 关闭
      React.useEffect(() => {
        if (!editor) return undefined
        const timer = window.setTimeout(() => {
          if (textareaRef.current) textareaRef.current.focus()
        }, 0)
        const onPointerDown = (event) => {
          const target = event.target
          if (target && target.closest && target.closest('[data-rnx-ui]')) return
          setEditor(null)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setEditor(null)
          }
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          window.clearTimeout(timer)
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [editor])

      function openEditor() {
        const snapshot = selectionRef.current || selection
        if (!snapshot) return
        setType('question')
        setText('')
        setError('')
        setEditor(snapshot)
        setSelection(null)
      }

      function saveEditor() {
        const snapshot = editorRef.current
        if (!snapshot) return
        if (!store.sessionId) {
          setError('当前没有可写入的会话输入框')
          return
        }
        const pendingCount = store.pendingFor(store.sessionId).length
        if (store.notesCount + pendingCount >= MAX_NOTES) {
          setError('已达 ' + MAX_NOTES + ' 条上限，先提交这一批再继续')
          return
        }
        const quote = normalizeQuote(snapshot.text)
        if (!quote) {
          setError('没有可用的引用文字')
          return
        }
        store.addNote(store.sessionId, {
          turn: snapshot.turn == null ? null : snapshot.turn,
          kindLabel: snapshot.kindLabel || '回答',
          offset: snapshot.offset == null ? null : snapshot.offset,
          quote,
          note: normalizeNote(text),
          type,
          createdAt: Date.now(),
        })
        setSaved('已加入批注' + (normalizeNote(text) ? '' : '（仅标记）'))
        window.clearTimeout(savedTimer.current)
        savedTimer.current = window.setTimeout(() => setSaved(''), 2200)
        setEditor(null)
        try {
          const browserSelection = window.getSelection()
          if (browserSelection) browserSelection.removeAllRanges()
        } catch (failure) {
          /* 忽略 */
        }
      }

      function onTextareaKeyDown(event) {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          saveEditor()
        }
      }

      if (editor) {
        const width = 360
        const height = 300
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight
        const left = Math.max(8, Math.min(editor.rect.right + 8, viewportWidth - width - 8))
        let top = editor.rect.bottom + 8
        if (top + height > viewportHeight - 8) top = Math.max(8, editor.rect.top - height - 8)
        return h(
          'div',
          { className: 'rnx-pop', 'data-rnx-ui': true, style: { left: left + 'px', top: top + 'px', width: width + 'px' } },
          h('div', { className: 'rnx-pop-head' }, '新增批注'),
          h(
            'div',
            { className: 'rnx-pop-quote' },
            h('span', { className: 'rnx-pop-quote-label' }, '引用'),
            h('span', { className: 'rnx-pop-quote-text' }, '「' + normalizeQuote(editor.text) + '」'),
          ),
          h(
            'div',
            { className: 'rnx-pop-types' },
            ['question', 'idea', 'mark'].map((key) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  className: 'rnx-type' + (type === key ? ' rnx-type-on' : ''),
                  onClick: () => setType(key),
                },
                TYPE_LABEL[key],
              ),
            ),
            editor.turn != null ? h('span', { className: 'rnx-pop-loc' }, '第' + editor.turn + '轮') : null,
          ),
          h('textarea', {
            ref: textareaRef,
            className: 'rnx-pop-input',
            placeholder: '写下你的想法或问题（可留空，仅标记这段）',
            value: text,
            rows: 4,
            onChange: (event) => setText(event.target.value),
            onKeyDown: onTextareaKeyDown,
          }),
          error ? h('div', { className: 'rnx-pop-error' }, error) : null,
          h(
            'div',
            { className: 'rnx-pop-foot' },
            h('span', { className: 'rnx-pop-hint' }, '⌘/Ctrl+Enter 保存 · Esc 取消'),
            h('button', { type: 'button', className: 'rnx-btn', onClick: () => setEditor(null) }, '取消'),
            h('button', { type: 'button', className: 'rnx-btn rnx-btn-primary', onClick: saveEditor }, '加入批注'),
          ),
        )
      }

      const toast = saved
        ? h('div', { className: 'rnx-toast', 'data-rnx-ui': true, role: 'status' }, saved)
        : null
      if (!selection) return toast
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const left = Math.max(8, Math.min(selection.rect.right + 6, viewportWidth - 104))
      let top = selection.rect.bottom + 8
      if (top + 34 > viewportHeight - 8) top = Math.max(8, selection.rect.top - 38)
      return h(
        'div',
        {
          className: 'rnx-toolbar',
          'data-rnx-ui': true,
          style: { left: left + 'px', top: top + 'px' },
          onMouseDown: (event) => event.preventDefault(),
        },
        h('button', { type: 'button', className: 'rnx-btn rnx-btn-toolbar', onClick: openEditor }, '＋ 批注'),
        toast,
      )
    }

    // ===== 批注托盘（session 作用域；拥有 inputActions / useInput）=====
    function GlossDock(props) {
      const sessionId = props.sessionId
      const inputActions = props.inputActions
      const useInput = typeof props.useInput === 'function' ? props.useInput : () => undefined
      const input = useInput((state) => state)
      const draft = input && typeof input.draft === 'string' ? input.draft : ''
      const parsed = parseBlock(draft)
      const notes = parsed.ok ? parsed.notes : []
      const signature = blockSignature(notes)
      const [auto, setAuto] = React.useState(() => {
        try {
          return localStorage.getItem(AUTO_KEY) !== '0'
        } catch (error) {
          return true
        }
      })
      const [open, setOpen] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [restoreNotes, setRestoreNotes] = React.useState(null)
      const [editingId, setEditingId] = React.useState(null)
      const [editingText, setEditingText] = React.useState('')
      const noticeTimer = React.useRef(0)
      const previousBlock = React.useRef(false)
      const sawSubmitting = React.useRef(false)
      const backupSignature = React.useRef('')
      useStoreTick()

      const pending = store.pendingFor(sessionId)
      const count = notes.length + pending.length
      const handEdited = parsed.present && !parsed.ok

      React.useEffect(() => {
        store.sessionId = sessionId
        store.emit()
        return () => {
          if (store.sessionId === sessionId) {
            store.sessionId = null
            store.emit()
          }
        }
      }, [sessionId])

      React.useEffect(() => {
        if (store.notesCount !== notes.length) {
          store.notesCount = notes.length
          store.emit()
        }
      }, [sessionId, signature])

      React.useEffect(() => {
        if (!input) return
        if (input.phase === 'submitting' || input.phase === 'adjudicating') {
          sawSubmitting.current = true
          if (!parsed.present) {
            try {
              localStorage.removeItem(BACKUP_PREFIX + sessionId)
            } catch (error) {
              /* 忽略 */
            }
            setRestoreNotes(null)
          }
        }
      }, [input && input.phase, parsed.present, sessionId])

      // 本地备份：只在批注内容变化时写；块被手动删掉时提示恢复；确认为发送则清理。
      React.useEffect(() => {
        if (!sessionId) return
        const key = BACKUP_PREFIX + sessionId
        const hasBlock = parsed.present && parsed.ok && notes.length > 0
        if (hasBlock) {
          previousBlock.current = true
          sawSubmitting.current = false
          if (backupSignature.current !== signature) {
            backupSignature.current = signature
            try {
              localStorage.setItem(
                key,
                JSON.stringify({ at: Date.now(), notes: notes.map(stripRuntimeNote) }),
              )
            } catch (error) {
              /* localStorage 不可用时静默 */
            }
          }
          setRestoreNotes(null)
          return
        }
        backupSignature.current = ''
        if (parsed.present && !parsed.ok) {
          previousBlock.current = true
          setRestoreNotes(null)
          return
        }
        if (previousBlock.current) {
          previousBlock.current = false
          if (sawSubmitting.current) {
            sawSubmitting.current = false
            try {
              localStorage.removeItem(key)
            } catch (error) {
              /* 忽略 */
            }
            setRestoreNotes(null)
          } else {
            loadBackup(key)
          }
          return
        }
        if (draft === '') loadBackup(key)
      }, [draft, signature, sessionId])

      function loadBackup(key) {
        try {
          const raw = localStorage.getItem(key)
          if (!raw) {
            setRestoreNotes(null)
            return
          }
          const data = JSON.parse(raw)
          const saved = data && Array.isArray(data.notes) ? data.notes : []
          setRestoreNotes(saved.length > 0 ? saved : null)
        } catch (error) {
          setRestoreNotes(null)
        }
      }

      function flash(message) {
        setNotice(message)
        window.clearTimeout(noticeTimer.current)
        noticeTimer.current = window.setTimeout(() => setNotice(''), 2800)
      }

      React.useEffect(
        () => () => {
          window.clearTimeout(noticeTimer.current)
        },
        [],
      )

      /**
       * 插件自己的写入会同步备份状态，避免「删掉最后一条批注」被误判成
       * 「用户手动删了块」而弹出恢复提示。
       */
      function syncBackup(nextNotes) {
        const key = BACKUP_PREFIX + sessionId
        try {
          if (nextNotes.length > 0) {
            backupSignature.current = blockSignature(nextNotes)
            localStorage.setItem(key, JSON.stringify({ at: Date.now(), notes: nextNotes.map(stripRuntimeNote) }))
            previousBlock.current = true
          } else {
            backupSignature.current = ''
            localStorage.removeItem(key)
            previousBlock.current = false
          }
          setRestoreNotes(null)
        } catch (error) {
          /* localStorage 不可用时静默 */
        }
      }

      function writeNotes(nextNotes) {
        if (!inputActions || typeof inputActions.setDraft !== 'function') {
          flash('输入框不可写：找不到 inputActions')
          return false
        }
        const blocked = writeBlockedReason(input)
        if (blocked) {
          flash(blocked)
          return false
        }
        try {
          inputActions.setDraft(mergeBlock(draft, nextNotes))
          syncBackup(nextNotes)
          return true
        } catch (error) {
          flash('写入输入框失败：' + errorMessage(error))
          return false
        }
      }

      function mergePending(manual) {
        const pendingNotes = store.pendingFor(sessionId)
        if (pendingNotes.length === 0) return
        if (!parsed.ok) {
          flash('草稿里的批注块被手动修改，暂不自动同步')
          return
        }
        if (notes.length + pendingNotes.length > MAX_NOTES) {
          flash('超过 ' + MAX_NOTES + ' 条上限，请先提交这一批')
          return
        }
        if (!manual && !auto) return
        if (!inputActions || typeof inputActions.setDraft !== 'function') {
          if (manual) flash('输入框不可写：找不到 inputActions')
          return
        }
        const blocked = writeBlockedReason(input)
        if (blocked) {
          if (manual) flash(blocked)
          return
        }
        const merged = mergeNotes(notes, pendingNotes)
        try {
          inputActions.setDraft(mergeBlock(draft, merged))
        } catch (error) {
          flash('写入输入框失败：' + errorMessage(error))
          return
        }
        store.takePending(sessionId)
        store.emit()
        if (manual) flash(pendingNotes.length + ' 条批注已合并到输入框')
      }

      // 自动同步：每次渲染后检查；条件不满足就等下一次输入状态变化。
      React.useEffect(() => {
        if (!auto) return
        if (handEdited) return
        mergePending(false)
      })

      function toggleAuto() {
        const next = !auto
        setAuto(next)
        try {
          localStorage.setItem(AUTO_KEY, next ? '1' : '0')
        } catch (error) {
          /* 忽略 */
        }
      }

      function clearAll() {
        if (count === 0) return
        if (!window.confirm('清空所有批注？已写进输入框的内容会被一并移除。')) return
        if (parsed.present && !writeNotes([])) return
        store.takePending(sessionId)
        store.emit()
        backupSignature.current = ''
        try {
          localStorage.removeItem(BACKUP_PREFIX + sessionId)
        } catch (error) {
          /* 忽略 */
        }
        setRestoreNotes(null)
        flash('已清空')
      }

      function removeNote(id) {
        writeNotes(notes.filter((note) => note.id !== id))
      }

      function startEdit(note) {
        setEditingId(note.id)
        setEditingText(note.note || '')
      }

      function saveEdit(id) {
        const next = notes.map((note) => (note.id === id ? { ...note, note: normalizeNote(editingText) } : note))
        if (writeNotes(next)) {
          setEditingId(null)
          setEditingText('')
        }
      }

      function jump(note) {
        if (note.turn == null) {
          flash('这条批注没有轮次信息，无法跳转')
          return
        }
        const element = document.querySelector('[data-chat-turn="' + note.turn + '"]')
        if (!element) {
          flash('第 ' + note.turn + ' 轮未加载，批注内容不受影响')
          return
        }
        element.scrollIntoView({ block: 'center', behavior: 'smooth' })
        element.classList.add('rnx-flash')
        window.setTimeout(() => element.classList.remove('rnx-flash'), 1400)
      }

      function copyBlock() {
        const cut = cutBlock(draft)
        const value = cut ? cut.block : draft
        if (!value) return
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(value).then(
            () => flash('批注块已复制'),
            () => flash('复制失败，请手动选择复制'),
          )
        } else {
          flash('浏览器不支持剪贴板写入，请手动复制')
        }
      }

      function restoreBackup() {
        if (!restoreNotes) return
        const merged = mergeNotes(notes, restoreNotes)
        if (writeNotes(merged)) {
          setRestoreNotes(null)
          flash('已恢复 ' + restoreNotes.length + ' 条批注')
        }
      }

      function dismissRestore() {
        try {
          localStorage.removeItem(BACKUP_PREFIX + sessionId)
        } catch (error) {
          /* 忽略 */
        }
        setRestoreNotes(null)
      }

      if (!sessionId) return null
      if (count === 0 && !restoreNotes && !handEdited) return null

      return h(
        'div',
        { className: 'rnx-dock', 'data-rnx-ui': true },
        h(
          'div',
          { className: 'rnx-bar' },
          h(
            'button',
            { type: 'button', className: 'rnx-chip', title: '展开/收起批注列表', onClick: () => setOpen(!open) },
            '✎ 批注 ' + count + ' 条',
            pending.length > 0 ? '（' + pending.length + ' 条待同步）' : '',
            h('span', { className: 'rnx-caret' }, open ? '▴' : '▾'),
          ),
          pending.length > 0
            ? h('button', { type: 'button', className: 'rnx-link', onClick: () => mergePending(true) }, '合并到输入框')
            : null,
          h(
            'label',
            { className: 'rnx-auto', title: '开启后，新批注会自动写进输入框草稿' },
            h('input', { type: 'checkbox', checked: auto, onChange: toggleAuto }),
            '自动同步',
          ),
          h('button', { type: 'button', className: 'rnx-link', onClick: clearAll }, '清空'),
        ),
        notice ? h('div', { className: 'rnx-notice' }, notice) : null,
        restoreNotes
          ? h(
              'div',
              { className: 'rnx-restore' },
              h('span', null, '检测到 ' + restoreNotes.length + ' 条未提交批注（本地备份）'),
              h('button', { type: 'button', className: 'rnx-link', onClick: restoreBackup }, '恢复'),
              h('button', { type: 'button', className: 'rnx-link', onClick: dismissRestore }, '忽略'),
            )
          : null,
        handEdited
          ? h(
              'div',
              { className: 'rnx-restore' },
              h('span', null, '草稿里的批注块被手动修改，托盘暂停同步'),
              h('button', { type: 'button', className: 'rnx-link', onClick: copyBlock }, '复制批注块'),
            )
          : null,
        open && notes.length > 0
          ? h(
              'div',
              { className: 'rnx-list' },
              notes.map((note) =>
                h(
                  'div',
                  { className: 'rnx-item', key: note.id },
                  h(
                    'div',
                    { className: 'rnx-item-head' },
                    h('span', { className: 'rnx-tag' }, note.turn == null ? '未知轮次' : '第' + note.turn + '轮'),
                    h('span', { className: 'rnx-tag rnx-tag-type' }, TYPE_LABEL[note.type] || TYPE_LABEL.question),
                    h('span', { className: 'rnx-spacer' }),
                    h('button', { type: 'button', className: 'rnx-icon', title: '跳转到原文', onClick: () => jump(note) }, '↗'),
                    h('button', { type: 'button', className: 'rnx-icon', title: '删除这条批注', onClick: () => removeNote(note.id) }, '×'),
                  ),
                  h('div', { className: 'rnx-quote' }, '「' + (note.quote || '（未取到原文）') + '」'),
                  editingId === note.id
                    ? h(
                        'div',
                        { className: 'rnx-edit' },
                        h('textarea', {
                          className: 'rnx-edit-input',
                          value: editingText,
                          rows: 3,
                          onChange: (event) => setEditingText(event.target.value),
                          onKeyDown: (event) => {
                            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                              event.preventDefault()
                              saveEdit(note.id)
                            }
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              setEditingId(null)
                            }
                          },
                        }),
                        h(
                          'div',
                          { className: 'rnx-edit-foot' },
                          h('button', { type: 'button', className: 'rnx-link', onClick: () => setEditingId(null) }, '取消'),
                          h('button', { type: 'button', className: 'rnx-btn rnx-btn-primary', onClick: () => saveEdit(note.id) }, '保存'),
                        ),
                      )
                    : h(
                        'div',
                        {
                          className: 'rnx-note' + (note.note ? '' : ' rnx-note-empty'),
                          title: '点击编辑',
                          onClick: () => startEdit(note),
                        },
                        note.note || '（未填写想法，点击补充）',
                      ),
                ),
              ),
            )
          : null,
        open && pending.length > 0
          ? h(
              'div',
              { className: 'rnx-list' },
              h(
                'div',
                { className: 'rnx-pending' },
                pending.map((note, index) =>
                  h(
                    'div',
                    { className: 'rnx-item rnx-item-pending', key: 'pending-' + index },
                    h(
                      'div',
                      { className: 'rnx-item-head' },
                      h('span', { className: 'rnx-tag' }, note.turn == null ? '未知轮次' : '第' + note.turn + '轮'),
                      h('span', { className: 'rnx-tag rnx-tag-type' }, '待同步'),
                    ),
                    h('div', { className: 'rnx-quote' }, '「' + (note.quote || '') + '」'),
                    h('div', { className: 'rnx-note' }, note.note || '（未填写想法）'),
                  ),
                ),
              ),
            )
          : null,
      )
    }

    // ===== 样式：宿主主题 token + 本插件前缀，卸载时随 style 一起移除 =====
    const CSS = [
      '.rnx-toolbar{position:fixed;z-index:50;pointer-events:auto;display:flex;align-items:center;',
      'padding:3px 4px;border:1px solid var(--dsw-alias-border-l1, #d0d5dd);border-radius:8px;',
      'background:var(--dsw-alias-bg-base, #fff);box-shadow:var(--dsw-elevation-panel, 0 6px 24px rgba(0,0,0,.16));}',
      '.rnx-btn{display:inline-flex;align-items:center;justify-content:center;height:26px;padding:0 10px;',
      'border:1px solid var(--dsw-alias-border-l1, #d0d5dd);border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-secondary, #475467);font-size:12px;line-height:1;cursor:pointer;font-family:inherit;}',
      '.rnx-btn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(16,24,40,.06));',
      'color:var(--dsw-alias-label-primary, #101828);}',
      '.rnx-btn-toolbar{border:none;height:28px;padding:0 8px;font-size:13px;color:var(--dsw-alias-label-primary, #101828);}',
      '.rnx-btn-primary{background:var(--dsw-alias-state-business-primary, #444ce7);border-color:transparent;color:#fff;}',
      '.rnx-btn-primary:hover{opacity:.9;color:#fff;}',
      '.rnx-pop{position:fixed;z-index:51;pointer-events:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;',
      'padding:12px;border:1px solid var(--dsw-alias-border-l1, #d0d5dd);border-radius:12px;',
      'background:var(--dsw-alias-bg-base, #fff);box-shadow:var(--dsw-elevation-panel, 0 12px 32px rgba(0,0,0,.18));',
      'color:var(--dsw-alias-label-primary, #101828);font-size:12px;}',
      '.rnx-pop-head{font-size:13px;font-weight:600;}',
      '.rnx-pop-quote{display:flex;gap:6px;max-height:52px;overflow:hidden;color:var(--dsw-alias-label-secondary, #475467);line-height:1.5;}',
      '.rnx-pop-quote-label{flex:none;color:var(--dsw-alias-label-tertiary, #667085);}',
      '.rnx-pop-quote-text{overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}',
      '.rnx-pop-types{display:flex;align-items:center;gap:6px;}',
      '.rnx-type{height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1, #d0d5dd);border-radius:999px;',
      'background:transparent;color:var(--dsw-alias-label-secondary, #475467);font-size:12px;cursor:pointer;font-family:inherit;}',
      '.rnx-type-on{background:var(--dsw-alias-state-business-primary, #444ce7);border-color:transparent;color:#fff;}',
      '.rnx-pop-loc{margin-left:auto;color:var(--dsw-alias-label-tertiary, #667085);}',
      '.rnx-pop-input{width:100%;box-sizing:border-box;resize:vertical;min-height:84px;max-height:220px;padding:8px;',
      'border:1px solid var(--dsw-alias-border-l1, #d0d5dd);border-radius:8px;background:var(--dsw-alias-bg-base, #fff);',
      'color:var(--dsw-alias-label-primary, #101828);font-size:13px;line-height:1.6;font-family:inherit;}',
      '.rnx-pop-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary, #444ce7);}',
      '.rnx-pop-error{color:var(--dsw-alias-state-error-primary, #d92d20);line-height:1.5;}',
      '.rnx-pop-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;}',
      '.rnx-pop-hint{margin-right:auto;color:var(--dsw-alias-label-tertiary, #667085);font-size:11px;}',
      '.rnx-dock{display:flex;flex-direction:column;gap:6px;padding-top:4px;color:var(--dsw-alias-label-secondary, #475467);',
      'font-size:12px;line-height:1.5;}',
      '.rnx-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.rnx-chip{display:inline-flex;align-items:center;gap:2px;height:26px;padding:0 10px;border-radius:6px;',
      'border:1px solid var(--dsw-alias-border-l1, #d0d5dd);background:transparent;color:var(--dsw-alias-label-secondary, #475467);',
      'font-size:12px;cursor:pointer;font-family:inherit;}',
      '.rnx-chip:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(16,24,40,.06));',
      'color:var(--dsw-alias-label-primary, #101828);}',
      '.rnx-caret{margin-left:4px;color:var(--dsw-alias-label-tertiary, #667085);}',
      '.rnx-link{border:none;background:transparent;padding:0;color:var(--dsw-alias-state-business-primary, #444ce7);',
      'font-size:12px;cursor:pointer;font-family:inherit;}',
      '.rnx-link:hover{text-decoration:underline;}',
      '.rnx-auto{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary, #667085);',
      'font-size:12px;cursor:pointer;user-select:none;}',
      '.rnx-auto input{margin:0;accent-color:var(--dsw-alias-state-business-primary, #444ce7);}',
      '.rnx-notice{padding:4px 8px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover-solid, rgba(16,24,40,.05));',
      'color:var(--dsw-alias-label-secondary, #475467);}',
      '.rnx-restore{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 8px;border-radius:8px;',
      'border:1px dashed var(--dsw-alias-border-l1, #d0d5dd);color:var(--dsw-alias-label-secondary, #475467);}',
      '.rnx-list{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto;padding-right:2px;}',
      '.rnx-item{padding:6px 8px;border:1px solid var(--dsw-alias-border-l1, #d0d5dd);border-radius:8px;',
      'background:var(--dsw-alias-bg-base, #fff);}',
      '.rnx-item-pending{opacity:.85;}',
      '.rnx-item-head{display:flex;align-items:center;gap:8px;}',
      '.rnx-tag{color:var(--dsw-alias-label-tertiary, #667085);}',
      '.rnx-tag-type{color:var(--dsw-alias-state-business-primary, #444ce7);}',
      '.rnx-spacer{flex:1;}',
      '.rnx-icon{width:22px;height:22px;border:none;border-radius:4px;background:transparent;cursor:pointer;',
      'color:var(--dsw-alias-label-tertiary, #667085);font-size:13px;line-height:1;font-family:inherit;}',
      '.rnx-icon:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(16,24,40,.06));',
      'color:var(--dsw-alias-label-primary, #101828);}',
      '.rnx-quote{color:var(--dsw-alias-label-tertiary, #667085);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.rnx-note{margin-top:2px;color:var(--dsw-alias-label-secondary, #475467);white-space:pre-wrap;cursor:text;}',
      '.rnx-note:hover{color:var(--dsw-alias-label-primary, #101828);}',
      '.rnx-note-empty{color:var(--dsw-alias-label-tertiary, #667085);font-style:italic;}',
      '.rnx-edit{display:flex;flex-direction:column;gap:6px;margin-top:4px;}',
      '.rnx-edit-input{width:100%;box-sizing:border-box;resize:vertical;padding:6px;border-radius:6px;',
      'border:1px solid var(--dsw-alias-border-l1, #d0d5dd);background:var(--dsw-alias-bg-base, #fff);',
      'color:var(--dsw-alias-label-primary, #101828);font-size:12px;line-height:1.5;font-family:inherit;}',
      '.rnx-edit-foot{display:flex;justify-content:flex-end;gap:8px;}',
      '.rnx-pending{display:flex;flex-direction:column;gap:6px;}',
      '.rnx-toast{position:fixed;right:20px;bottom:96px;z-index:52;pointer-events:none;',
      'padding:6px 12px;border-radius:8px;background:var(--dsw-alias-bg-base, #fff);',
      'border:1px solid var(--dsw-alias-border-l1, #d0d5dd);box-shadow:var(--dsw-elevation-panel, 0 8px 24px rgba(0,0,0,.16));',
      'color:var(--dsw-alias-label-secondary, #475467);font-size:12px;}',
      '.rnx-flash{animation:rnx-flash 1.4s ease-out;}',
      '@keyframes rnx-flash{0%{outline:2px solid var(--dsw-alias-state-business-primary, #444ce7);outline-offset:2px;}',
      '100%{outline:2px solid transparent;outline-offset:2px;}}',
    ].join('\n')

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = '@local/gloss'
          style.dataset.pluginCss = '@local/gloss/client.css'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, '@local/gloss: styles')

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'gloss-overlay',
            },
            GlossOverlay,
          ),
        )

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'gloss-dock',
              order: 3,
            },
            GlossDock,
          ),
        )
      },
    }
  },
})
