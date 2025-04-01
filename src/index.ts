import { Context, Schema, h } from 'koishi'
import { parseDocument } from 'yaml'
import { spawn, exec } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import fs from 'fs'
import {} from "@koishijs/plugin-notifier"

export const name = 'jm2pdf'

export const usage = `更新日志：https://forum.koishi.xyz/t/topic/10694  
使用本插件需要安装Python  
若未安装请在 https://www.python.org 安装并勾选“Add Python to PATH”`

export interface Config {
  cache: boolean
  maxCache?: number
  clearAtRestart?: boolean
  python: string
  proxy: string
  debug: boolean
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    cache: Schema.boolean()
    .description("下载的本子是否缓存在本地")
    .default(true),
  }).description("缓存设置"),
  Schema.union([
    Schema.object({
      cache: Schema.const(true),
      maxCache: Schema.number()
        .default(0)
        .description("最多缓存几个本子，超出时删除最早的缓存，为0则不限制"),
      clearAtRestart: Schema.boolean()
        .default(false)
        .description("重启插件时是否清除缓存")
    }),
    Schema.object({
      cache: Schema.const(false).required(),
    })
  ]),

  Schema.object({
    python: Schema.string()
      .description("指定python解释器可执行文件路径，空则使用环境变量")
      .default(""),
    proxy: Schema.string()
      .description("代理服务器地址，空则不使用代理")
      .default(""),
    debug: Schema.boolean()
      .description("调试模式，打印更多日志")
      .default(false)
  }).description("杂项")
])

export const inject = ["notifier"]

const execPromise = promisify(exec)

export async function apply(ctx: Context, config: Config) {
  const notifier = ctx.notifier.create()

  if (config.python && !fs.existsSync(config.python)) {
    ctx.logger("jm2pdf").warn("python解释器路径不存在")
    notifier.update({type: "danger", content: "python解释器路径不存在"})
    return
  }

  try {
    await execPromise(`${config.python || 'python'} -m pip install --upgrade --user -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple -r ${join(__dirname, "./../image2pdf/requirements.txt")}`)
  } catch (e) {
    ctx.logger("jm2pdf").warn("下载第三方库失败: " + e)
    notifier.update({type: "danger", content: "下载第三方库失败：" + e})
    return
  }
  
  const cache = new Map()
  if (config.clearAtRestart) fs.rmSync(join(ctx.baseDir, `cache/jmcomic`), { recursive: true, force: true });

  const jmConfigPath = join(__dirname, "./../image2pdf/config.yml")
  const jmConfig = parseDocument(fs.readFileSync(jmConfigPath, "utf-8"))
  jmConfig.setIn(["dir_rule", "base_dir"], join(ctx.baseDir, "cache/jmcomic"))
  if (config.proxy) {
    jmConfig.setIn(["client", "postman", "meta_data", "proxies"], config.proxy)
  } else {
    jmConfig.setIn(["client", "postman", "meta_data", "proxies"], null)
  }
  fs.writeFileSync(jmConfigPath, jmConfig.toString())

  ctx.command("jmcomic <id:posint>", "通过JM号获取本子并发送pdf", {checkArgCount: true})
    .example("jmcomic 366517")
    .action(async ({session}, id) => {
      if (cache.get(id)) {
        await session.send(h.quote(session.messageId) + "已从缓存中找到，正在发送...")
        return h.file(`file:///${join(ctx.baseDir, `cache/jmcomic/${cache.get(id)}`)}`)
      }
      
      session.send(h.quote(session.messageId) + "正在下载...")

      const pythonProcess = spawn(config.python || 'python', ["-u", join(__dirname, "./../image2pdf/main.py"), id.toString(), jmConfigPath])

      pythonProcess.stdout.on("data", async (data: Buffer) => {
        const response = data.toString("utf-8").trim()
        if (response.startsWith("result:")) {
          const pdf = JSON.parse(response.replace("result:", ""))
          cache.set(id, pdf.name)
          await session.send(h.file(`file:///${join(ctx.baseDir, `cache/jmcomic/${pdf.name}`)}`))
          fs.rmSync(join(ctx.baseDir, `cache/jmcomic/${pdf.name.replace(".pdf", "").replace(/\(\d+\) /, "")}`), { recursive: true, force: true });
          if (!config.cache) {
            fs.rmSync(join(ctx.baseDir, `cache/jmcomic`), { recursive: true, force: true });
          } else if (config.maxCache !== 0 && cache.size > config.maxCache) {
            const earliestCache = cache.entries().next()
            cache.delete(earliestCache.value[0])
            fs.rmSync(join(ctx.baseDir, `cache/jmcomic/${earliestCache.value[1]}`), { recursive: true, force: true });
          }
        } else if (config.debug) {
          ctx.logger("jm2pdf").info(response)
        }
      })

      pythonProcess.stderr.on("data", (data: Buffer) => {
        if (config.debug) ctx.logger("jm2pdf").warn(data.toString("utf-8"))
        return h.quote(session.messageId) + "下载时遇到错误，可能是网络问题或JM号不存在，使用调试模式查看更多日志信息"
      })
    })
}
