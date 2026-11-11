/**
 * 把本插件装进当前 DSH profile（默认 desktop），做成可热生效的形态。
 *
 * 与 DSH 社区插件的 install.mjs 同一套做法（实测于 Desktop 0.2.1-rc.5）：
 *   1. profile 的 dependencies 里加 `link:<本目录>`；
 *   2. profile 的 node_modules 下建相对 symlink；
 *   3. profile 的 cordis.patch.yml 追加带标记的 insert 段落（HMR 会捕获并热重载）。
 *
 * ⚠️ 本脚本会写 ~/.dsh（workspace 之外），执行前请确认。
 * 用法：node install.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)))
const PKG_NAME = '@local/gloss'
const MARK_BEGIN = '# >>> @local/gloss'
const MARK_END = '# <<< @local/gloss'
// 旧名（2026-11-11 起由 reading-notes 改名）：装新名时顺手清掉，
// 否则 profile 里会留下指向旧目录的断链 symlink 和重复的激活条目。
const LEGACY_PKG_NAME = '@local/reading-notes'
const LEGACY_MARK_BEGIN = '# >>> @local/reading-notes'
const LEGACY_MARK_END = '# <<< @local/reading-notes'
const rawProfileDir =
  process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh/profiles/desktop')
const profileDir = fs.existsSync(rawProfileDir) ? fs.realpathSync(rawProfileDir) : rawProfileDir
const profilePkgPath = path.join(profileDir, 'package.json')
const patchPath = path.join(profileDir, 'cordis.patch.yml')

if (!fs.existsSync(profilePkgPath)) {
  console.error('找不到 profile 的 package.json:', profilePkgPath)
  process.exit(1)
}
if (!fs.existsSync(patchPath)) {
  console.error('找不到 profile 的 cordis.patch.yml:', patchPath)
  process.exit(1)
}

/** 从 patch 文本里删掉一段管理块（含首尾标记）。返回 [新文本, 是否删除]。 */
function stripPatchBlock(text, markBegin, markEnd) {
  const begin = text.indexOf(markBegin)
  const end = text.indexOf(markEnd)
  if (begin < 0 || end <= begin) return [text, false]
  const cleaned = (text.slice(0, begin) + text.slice(end + markEnd.length))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
  return [cleaned, true]
}

// 0) 备份
const backupDir = path.join(here, '.backup')
fs.mkdirSync(backupDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
fs.writeFileSync(path.join(backupDir, `profile-package-${stamp}.json`), fs.readFileSync(profilePkgPath))
fs.writeFileSync(path.join(backupDir, `profile-cordis-patch-${stamp}.yml`), fs.readFileSync(patchPath))
console.log('[1/6] 备份完成:', backupDir)

// 1) 清理旧名残留
{
  const removed = []
  const legacyLink = path.join(profileDir, 'node_modules', LEGACY_PKG_NAME)
  try {
    fs.unlinkSync(legacyLink)
    removed.push('symlink')
  } catch {
    /* 没有就算了 */
  }
  const [cleanedPatch, patchRemoved] = stripPatchBlock(
    fs.readFileSync(patchPath, 'utf8'),
    LEGACY_MARK_BEGIN,
    LEGACY_MARK_END,
  )
  if (patchRemoved) {
    fs.writeFileSync(patchPath, cleanedPatch)
    removed.push('patch')
  }
  const legacyPkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'))
  if (legacyPkg.dependencies && legacyPkg.dependencies[LEGACY_PKG_NAME]) {
    delete legacyPkg.dependencies[LEGACY_PKG_NAME]
    fs.writeFileSync(profilePkgPath, JSON.stringify(legacyPkg, null, 2) + '\n')
    removed.push('dependency')
  }
  console.log(
    removed.length ? `[2/6] 已清理旧名 ${LEGACY_PKG_NAME} 的残留: ${removed.join(', ')}` : '[2/6] 无旧名残留',
  )
}

// 2) 依赖登记为 link:
const pkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'))
pkg.dependencies = pkg.dependencies || {}
pkg.dependencies[PKG_NAME] = 'link:' + here
fs.writeFileSync(profilePkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log('[3/6] 已登记依赖:', PKG_NAME, '-> link:' + here)

// 3) symlink
const linkPath = path.join(profileDir, 'node_modules', PKG_NAME)
fs.mkdirSync(path.dirname(linkPath), { recursive: true })
const relTarget = path.relative(path.dirname(linkPath), here)
try {
  fs.unlinkSync(linkPath)
} catch {
  /* 不存在就算了 */
}
fs.symlinkSync(relTarget, linkPath)
console.log('[4/6] symlink:', linkPath, '->', relTarget)

// 4) patch 层激活（幂等）
let patch = fs.readFileSync(patchPath, 'utf8')
if (patch.includes(MARK_BEGIN)) {
  console.log('[5/6] patch 已含本插件段落，跳过')
} else {
  const block = [
    '',
    MARK_BEGIN + ' (managed by this repo\'s install.mjs, do not edit by hand)',
    '- insert:',
    '    - id: gloss',
    `      name: '${PKG_NAME}'`,
    '      config: {}',
    MARK_END,
    '',
  ].join('\n')
  patch = patch.replace(/\n*$/, '\n') + block
  fs.writeFileSync(patchPath, patch)
  console.log('[5/6] patch 已插入激活段落')
}

// 5) 回读
const check = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'))
console.log('[6/6] 验证:')
console.log('  dependency   =', check.dependencies[PKG_NAME])
console.log('  symlink 有效 =', fs.lstatSync(linkPath).isSymbolicLink(), '->', fs.realpathSync(linkPath))
console.log('  patch 标记   =', fs.readFileSync(patchPath, 'utf8').includes(MARK_BEGIN))
console.log('  旧名残留     =', fs.existsSync(path.join(profileDir, 'node_modules', LEGACY_PKG_NAME)))
console.log('\npatch 变化会被 HMR 捕获，Host 半侧几秒内热加载；浏览器半侧刷新一次页面后生效。')
