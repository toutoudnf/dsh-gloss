/**
 * Host 半侧：保持空壳，只写一条加载心跳。
 *
 * 为什么一个「纯 Client 插件」还需要 Host 行：
 *   DSH 的浏览器 bundle 是从「已启用的 Loader 条目」扫描 `dsh.client` 声明后提供的，
 *   所以插件必须作为一条 Host 插件行被启用；本插件没有任何 Host 侧能力（无命令、
 *   无工具、无文件写入、无网络）。
 *
 * 心跳仅用于确认 Host 侧确实激活了本插件（调试用，失败不影响插件本身）。
 * 真正逻辑全部在 client.js（浏览器侧）。
 */
import { appendFileSync } from 'node:fs'

export function apply() {
  try {
    appendFileSync(
      new URL('./.host-loaded.log', import.meta.url),
      `${new Date().toISOString()} apply() ran\n`,
    )
  } catch {
    /* 心跳失败不影响插件本身 */
  }
}
