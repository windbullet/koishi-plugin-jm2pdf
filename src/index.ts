import { Context, Schema, h } from 'koishi'
import { parseDocument } from 'yaml'
import { spawn, exec } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import fs from 'fs'
import {} from "@koishijs/plugin-notifier"
import archiver, { ArchiverOptions } from 'archiver'
import { pathToFileURL } from 'url'
if (!archiver.isRegisteredFormat('zip-encrypted')) {
  archiver.registerFormat('zip-encrypted', require("archiver-zip-encrypted"));
} 

export const name = 'jm2pdf'

export const usage = `更新日志：https://forum.koishi.xyz/t/topic/10694  
使用本插件需要安装Python  
若未安装请在 https://www.python.org 安装并勾选“Add Python to PATH” 后重启电脑`

export interface Config {
  cache: boolean
  maxCache?: number
  clearAtRestart?: boolean
  fullName: boolean
  fileFormat: "pdf" | "zip"
  zipPassword?: string
  python: string
  autoDownloadDependencies: boolean
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
    fullName: Schema.boolean()
      .description("发送的文件名是否为本子全名（否则仅JM号）")
      .default(true),
    fileFormat: Schema.union([
      Schema.const("pdf").description("发送PDF文件"),
      Schema.const("zip").description("发送ZIP文件"),
    ]).default("pdf").description("发送的文件格式"),
  }).description("文件设置"),
  Schema.union([
    Schema.object({
      fileFormat: Schema.const("zip").required(),
      zipPassword: Schema.string()
        .default("")
        .description("ZIP文件的密码，空则不加密"),
    }),
    Schema.object({
      fileFormat: Schema.const("pdf")
    })
  ]),

  Schema.object({
    python: Schema.string()
      .description("指定python解释器可执行文件路径，空则使用环境变量")
      .default(""),
    autoDownloadDependencies: Schema.boolean()
      .description("是否自动下载需要的第三方库（jmcomic, pillow, pyyaml）")
      .default(true),
    proxy: Schema.string()
      .description("代理服务器地址，空则不使用代理")
      .default(""),
    debug: Schema.boolean()
      .description("调试模式，打印更多日志")
      .default(false),
  }).description("杂项")
])

export const inject = ["notifier"]

const execPromise = promisify(exec)

export async function apply(ctx: Context, config: Config) {
  const notifier = ctx.notifier.create()
  notifier.update({type: "warning", content: "正在初始化..."})

  const cacheDir = join(ctx.baseDir, `cache/jmcomic`)
  let pythonPath = config.python

  if (!pythonPath) {
    try {
      await execPromise(`python -m venv ${join(ctx.baseDir, `data/jmcomicVenv`)}`)
      pythonPath = process.platform === 'win32'
      ? join(ctx.baseDir, 'data/jmcomicVenv/Scripts/python')
      : join(ctx.baseDir, 'data/jmcomicVenv/bin/python');
    } catch (e) {
      ctx.logger("jm2pdf").warn("创建python虚拟环境失败：" + e)
      notifier.update({type: "danger", content: "创建python虚拟环境失败：" + e})
      return
    }
  } else if (!fs.existsSync(config.python)) {
    ctx.logger("jm2pdf").warn("python解释器路径不存在")
    notifier.update({type: "danger", content: "python解释器路径不存在"})
    return
  }

  if (config.autoDownloadDependencies) {
    try {
      await execPromise(`${pythonPath} -m pip install --upgrade -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple -r ${join(__dirname, "./../image2pdf/requirements.txt")}`)
    } catch (e) {
      ctx.logger("jm2pdf").warn("下载第三方库失败: " + e)
      notifier.update({type: "danger", content: "下载第三方库失败：" + e})
      return
    }
  }

  const cache: Map<number, string> = new Map()

  if (config.clearAtRestart) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  } else if (fs.existsSync(cacheDir)) {
    const files = fs.readdirSync(cacheDir)

    const filesWithStats = []
    files.forEach(file => {
      const filePath = join(cacheDir, file)
      const stats = fs.statSync(filePath)
      if (stats.isDirectory()) {
        fs.rmSync(filePath, { recursive: true, force: true })
      } else {
        filesWithStats.push({
          name: file,
          createdAt: stats.birthtime
        })
      }
    })

    for (const file of filesWithStats.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      cache.set(+file.name.match(/\((\d+)\) /)[1], file.name)
    }
  }

  const jmConfigPath = join(__dirname, "./../image2pdf/config.yml")
  const jmConfig = parseDocument(fs.readFileSync(jmConfigPath, "utf-8"))
  jmConfig.setIn(["dir_rule", "base_dir"], cacheDir)
  jmConfig.setIn(["client", "postman", "meta_data", "proxies"], config.proxy || null)
  fs.writeFileSync(jmConfigPath, jmConfig.toString())

  notifier.dispose()

  ctx.command("jmcomic <id:posint>", "通过JM号获取本子并发送pdf", {checkArgCount: true})
    .example("jmcomic 366517")
    .action(async ({session}, id) => {
      if (cache.get(id)) {
        await session.send(h.quote(session.messageId) + "已从缓存中找到，正在发送...")
        switch (config.fileFormat) {
          case "pdf":
            return h.file(pathToFileURL(join(cacheDir, cache.get(id))).href, {title: config.fullName ? cache.get(id) : `${id}.pdf`})
          case "zip":
            await zip(join(cacheDir, cache.get(id)), join(cacheDir, `${id}.zip`), cache.get(id))
            await session.send(h.file(pathToFileURL(join(cacheDir, `${id}.zip`)).href, {title: config.fullName ? cache.get(id).replace(".pdf", ".zip") : `${id}.zip`}))
            config.zipPassword && await session.send(`解压密码：${config.zipPassword}`)
            fs.unlinkSync(join(cacheDir, `${id}.zip`))
            return
        }
      }
      
      session.send(h.quote(session.messageId) + "正在下载...")

      const pythonProcess = spawn(pythonPath, ["-u", join(__dirname, "./../image2pdf/main.py"), id.toString(), jmConfigPath])

      let success = false
      pythonProcess.stdout.on("data", async (data: Buffer) => {
        const response = data.toString("utf-8").trim()
        if (response.startsWith("result:")) {
          success = true
          const pdf = JSON.parse(response.replace("result:", ""))

          switch (config.fileFormat) {
            case "pdf":
              await session.send(h.file(pathToFileURL(join(cacheDir, pdf.name)).href, {title: config.fullName ? pdf.name : `${id}.pdf`}))
              break
            case "zip":
              await zip(join(cacheDir, pdf.name), join(cacheDir, `${id}.zip`), pdf.name)
              await session.send(h.file(pathToFileURL(join(cacheDir, `${id}.zip`)).href, {title: config.fullName ? pdf.name.replace(".pdf", ".zip") : `${id}.zip`}))
              config.zipPassword && await session.send(`解压密码：${config.zipPassword}`)
              fs.unlinkSync(join(cacheDir, `${id}.zip`))
              break
          }

          fs.rmSync(join(cacheDir, pdf.name.replace(".pdf", "").replace(/\(\d+\) /, "")), { recursive: true, force: true });
          if (!config.cache) {
            fs.rmSync(cacheDir, { recursive: true, force: true });
            return
          } 

          cache.set(id, pdf.name)
          if (config.maxCache !== 0 && cache.size > config.maxCache) {
            const cacheEntries = cache.entries()
            const cacheSize = cache.size
            for (let i = 0; i < cacheSize - config.maxCache; i++) {
              const earliestCache = cacheEntries.next()
              cache.delete(earliestCache.value[0])
              fs.rmSync(join(cacheDir, earliestCache.value[1]), { recursive: true, force: true });
            }
          }
        } else if (config.debug) {
          ctx.logger("jm2pdf").info(response)
        }
      })

      pythonProcess.stderr.on("data", async (data: Buffer) => {
        if (config.debug) ctx.logger("jm2pdf").warn(data.toString("utf-8"))
      })

      pythonProcess.on("close", async () => {
        if (!success) {
          await session.send(h.quote(session.messageId) + "下载时遇到错误，可能是网络问题或JM号不存在，使用调试模式查看更多日志信息")
        }
      })
    })

  async function zip(inputPath: string, outputPath: string, fileName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath)

      let archive: archiver.Archiver
      if (config.zipPassword) {
        archive = archiver.create("zip-encrypted", {
          encryptionMethod: "aes256",
          password: config.zipPassword,
        } as unknown as ArchiverOptions)
      } else {
        archive = archiver("zip")
      }

      output.on("close", () => {
        resolve()
      })

      archive.on("error", (err: Error) => {
        reject(err)
      })
  
      archive.pipe(output)
      archive.file(inputPath, { name: fileName })
      archive.finalize()
    })
  }
}


