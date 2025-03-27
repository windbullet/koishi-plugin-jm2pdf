import { Context, Schema, h } from 'koishi'
import { parseDocument } from 'yaml'
import { spawn } from 'child_process'
import { join } from 'path'
import fs from 'fs'

export const name = 'jm2pdf'

export interface Config {
  cache: boolean
  proxy: string
  debug: boolean
}

export const Config: Schema<Config> = Schema.object({
  cache: Schema.boolean()
    .description("下载的本子是否缓存在本地（重启插件时清除缓存）")
    .default(true),
  proxy: Schema.string()
    .description("代理服务器地址，空则不使用代理")
    .default(""),
  debug: Schema.boolean()
    .description("调试模式，打印更多日志")
    .default(false)
})

export function apply(ctx: Context, config: Config) {
  fs.rmSync(join(ctx.baseDir, `cache/jmcomic`), { recursive: true, force: true });
  
  const jmConfigPath = join(__dirname, "./../image2pdf/config.yml")
  const jmConfig = parseDocument(fs.readFileSync(jmConfigPath, "utf-8"))
  jmConfig.setIn(["dir_rule", "base_dir"], join(ctx.baseDir, "cache/jmcomic"))
  if (config.proxy) {
    jmConfig.setIn(["client", "postman", "meta_data", "proxies"], config.proxy)
  } else {
    jmConfig.setIn(["client", "postman", "meta_data", "proxies"], null)
  }
  fs.writeFileSync(jmConfigPath, jmConfig.toString())

  ctx.command("jmcomic <id:posint>")
    .action(async ({session}, id) => {
      session.send(h.quote(session.messageId) + "正在下载...")

      const pythonProcess = spawn('python', ["-u", join(__dirname, "./../image2pdf/main.py"), id.toString(), jmConfigPath])

      pythonProcess.stdout.on("data", async (data: Buffer) => {
        const response = data.toString("utf-8").trim()
        if (response.startsWith("result:")) {
          const pdf = JSON.parse(response.replace("result:", ""))
          await session.send(h.file(`file:///${join(ctx.baseDir, `cache/jmcomic/${pdf.name}`)}`))
          if (!config.cache) fs.rmSync(join(ctx.baseDir, `cache/jmcomic`), { recursive: true, force: true });
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
