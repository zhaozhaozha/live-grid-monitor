/**
 * 生成 Windows 安装包/快捷方式用的多尺寸 ICO 图标（零依赖，手写 BMP-based ICO）。
 *
 * 用法: node installer/tools/make-icon.mjs
 * 输出: installer/assets/app.ico
 *
 * ICO 结构: ICONDIR(6) + ICONDIRENTRY(16/张) + 若干 BITMAPINFOHEADER(40) + BGRA 像素 + AND mask
 * 注意 BMP 在 ICO 中的 biHeight 需写 2 倍高度（像素 + mask）。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIZES = [16, 32, 48, 64, 256]

const BG = [0x7c, 0x44, 0x0c, 0xff] // #0C447C (blue-800) 存为 BGRA
const CELL = [0xff, 0xff, 0xff, 0xff] // 宫格：白
const LIVE = [0x4a, 0x4b, 0xe2, 0xff] // #E24B4A (red-400) 直播中指示
const TRANSPARENT = [0, 0, 0, 0]

function inRoundedRect(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - 1 - radius)
  const cy = Math.min(Math.max(y, radius), size - 1 - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius || (x >= radius && x < size - radius) || (y >= radius && y < size - radius)
}

/** 画一张 size×size 的 BGRA 位图（自下而上，ICO/BMP 要求） */
function drawImage(size) {
  const px = Buffer.alloc(size * size * 4)
  const radius = size * 0.18
  const margin = size * 0.22
  const gap = size * 0.07
  const cell = (size - 2 * margin - 2 * gap) / 3

  for (let row = 0; row < size; row++) {
    // BMP 自下而上存储
    const y = size - 1 - row
    for (let x = 0; x < size; x++) {
      const off = (row * size + x) * 4
      let color = TRANSPARENT

      if (inRoundedRect(x, y, size, radius)) {
        color = BG
        // 判断落在哪个宫格
        const gx = x - margin
        const gy = y - margin
        if (gx >= 0 && gy >= 0) {
          const ci = Math.floor(gx / (cell + gap))
          const cj = Math.floor(gy / (cell + gap))
          if (ci >= 0 && ci < 3 && cj >= 0 && cj < 3) {
            const inX = gx - ci * (cell + gap) <= cell
            const inY = gy - cj * (cell + gap) <= cell
            if (inX && inY) {
              // 左上角那格标红，代表「直播中」
              color = ci === 0 && cj === 0 ? LIVE : CELL
            }
          }
        }
      }
      px[off] = color[0]
      px[off + 1] = color[1]
      px[off + 2] = color[2]
      px[off + 3] = color[3]
    }
  }
  return px
}

function buildIco() {
  const images = SIZES.map((size) => {
    const pixels = drawImage(size)
    const maskRowBytes = Math.ceil(size / 32) * 4
    const mask = Buffer.alloc(maskRowBytes * size) // 全 0：不透明区域由 alpha 通道决定
    const dib = Buffer.alloc(40)
    dib.writeUInt32LE(40, 0) // biSize
    dib.writeInt32LE(size, 4) // biWidth
    dib.writeInt32LE(size * 2, 8) // biHeight = 像素 + mask
    dib.writeUInt16LE(1, 12) // biPlanes
    dib.writeUInt16LE(32, 14) // biBitCount
    dib.writeUInt32LE(0, 16) // biCompression = BI_RGB
    dib.writeUInt32LE(pixels.length + mask.length, 20) // biSizeImage
    return { size, data: Buffer.concat([dib, pixels, mask]) }
  })

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(images.length, 4)

  const entries = Buffer.alloc(16 * images.length)
  let offset = 6 + 16 * images.length
  images.forEach((img, i) => {
    const base = i * 16
    entries[base] = img.size >= 256 ? 0 : img.size
    entries[base + 1] = img.size >= 256 ? 0 : img.size
    entries[base + 2] = 0 // colorCount
    entries[base + 3] = 0 // reserved
    entries.writeUInt16LE(1, base + 4) // planes
    entries.writeUInt16LE(32, base + 6) // bitCount
    entries.writeUInt32LE(img.data.length, base + 8)
    entries.writeUInt32LE(offset, base + 12)
    offset += img.data.length
  })

  return Buffer.concat([header, entries, ...images.map((i) => i.data)])
}

const out = resolve(__dirname, '../assets/app.ico')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, buildIco())
console.log(`✓ 已生成 ${out}（尺寸: ${SIZES.join('/')}）`)
