/**
 * Генератор иконок расширения (public/icons/icon{16,32,48,128}.png).
 *
 * Chrome принимает в манифесте только растровые иконки (PNG), SVG не работает.
 * Готовых растеризаторов в зависимостях нет и тащить ради четырёх картинок
 * нативный биндинг (sharp/resvg) не хочется, поэтому иконки рисуются
 * попиксельно и кодируются в PNG вручную: zlib есть в стандартной библиотеке
 * Node, а формат PNG в минимальном варианте — это четыре чанка.
 *
 * Запуск: npm run icons
 * Результат коммитится в репозиторий, при обычной сборке скрипт не вызывается.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SIZES = [16, 32, 48, 128]
const SUPERSAMPLE = 4 // сглаживание: рисуем в 4 раза крупнее и усредняем

// ---------------------------------------------------------------- рисование

/** Цвета градиента фона: синий -> фиолетовый. */
const COLOR_A = [0x4f, 0x7d, 0xf3]
const COLOR_B = [0x8b, 0x5c, 0xf6]

/**
 * Скруглённый квадрат в нормализованных координатах 0..1.
 * Классический приём: расстояние до «внутреннего» прямоугольника,
 * стянутого на радиус со всех сторон. Внутри него dx=dy=0.
 */
function insideRoundedRect(x, y, radius) {
  const dx = Math.max(radius - x, x - (1 - radius), 0)
  const dy = Math.max(radius - y, y - (1 - radius), 0)
  return dx * dx + dy * dy <= radius * radius
}

/**
 * Глиф: стрелка вверх над горизонтальной линией — «поднять качество».
 *
 * ГЛИФ ЗАВИСИТ ОТ РАЗМЕРА, и это главное, что изменилось на этапе 9.
 *
 * Иконка 16×16 — это шестнадцать пикселей на всю картинку. Опорная линия
 * толщиной 0.08 от высоты превращается в ней в 1.3 пикселя: после сглаживания
 * получается серая полоска, которую не видно, но которая делает изображение
 * грязным. То же с тонкими скруглениями.
 *
 * Поэтому маленькие размеры рисуются упрощённо: без опорной линии, стрелка
 * толще и крупнее. Это стандартная практика для иконок, и её отсутствие —
 * причина, по которой самодельные иконки выглядят мыльными в панели браузера.
 */
function insideGlyph(x, y, detailed) {
  if (detailed) {
    // Опорная линия снизу.
    if (x >= 0.26 && x <= 0.74 && y >= 0.78 && y <= 0.86) return true
    // Ствол стрелки.
    if (x >= 0.435 && x <= 0.565 && y >= 0.40 && y <= 0.72) return true
    // Наконечник: треугольник с вершиной сверху.
    if (y >= 0.175 && y <= 0.44) {
      const t = (y - 0.175) / (0.44 - 0.175)
      if (Math.abs(x - 0.5) <= 0.215 * t) return true
    }
    return false
  }

  // Упрощённый вариант: только стрелка, крупнее и толще.
  if (x >= 0.40 && x <= 0.60 && y >= 0.42 && y <= 0.80) return true
  if (y >= 0.16 && y <= 0.48) {
    const t = (y - 0.16) / (0.48 - 0.16)
    if (Math.abs(x - 0.5) <= 0.28 * t) return true
  }
  return false
}

/** Цвет и альфа в точке (x, y), координаты нормализованы в 0..1. */
function sample(x, y, detailed) {
  // Скругление тоже зависит от размера: на 16 px радиус 0.22 съедает
  // заметную долю площади и икона выглядит круглой, а не квадратной.
  if (!insideRoundedRect(x, y, detailed ? 0.22 : 0.18)) return [0, 0, 0, 0]
  if (insideGlyph(x, y, detailed)) return [255, 255, 255, 1]
  const t = (x + y) / 2
  return [
    COLOR_A[0] + (COLOR_B[0] - COLOR_A[0]) * t,
    COLOR_A[1] + (COLOR_B[1] - COLOR_A[1]) * t,
    COLOR_A[2] + (COLOR_B[2] - COLOR_A[2]) * t,
    1,
  ]
}

/** Рендер одной иконки размера size в буфер RGBA. */
function render(size) {
  // Ниже 32 px мелкие детали не выживают — рисуем упрощённый глиф.
  const detailed = size >= 32
  const n = size * SUPERSAMPLE
  const samplesPerPixel = SUPERSAMPLE * SUPERSAMPLE
  // Накапливаем цвет, умноженный на альфу (premultiplied) — иначе на границе
  // фигуры прозрачные пиксели «замешивают» в край чёрный цвет.
  const acc = new Float64Array(size * size * 4)

  for (let py = 0; py < n; py++) {
    const y = (py + 0.5) / n
    const row = Math.floor(py / SUPERSAMPLE)
    for (let px = 0; px < n; px++) {
      const x = (px + 0.5) / n
      const [r, g, b, a] = sample(x, y, detailed)
      const i = (row * size + Math.floor(px / SUPERSAMPLE)) * 4
      acc[i] += r * a
      acc[i + 1] += g * a
      acc[i + 2] += b * a
      acc[i + 3] += a
    }
  }

  const rgba = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const alpha = acc[i * 4 + 3] / samplesPerPixel
    if (alpha <= 0) continue
    // Обратно из premultiplied в обычный RGBA.
    rgba[i * 4] = Math.round(acc[i * 4] / samplesPerPixel / alpha)
    rgba[i * 4 + 1] = Math.round(acc[i * 4 + 1] / samplesPerPixel / alpha)
    rgba[i * 4 + 2] = Math.round(acc[i * 4 + 2] / samplesPerPixel / alpha)
    rgba[i * 4 + 3] = Math.round(alpha * 255)
  }
  return rgba
}

// ------------------------------------------------------------ кодирование PNG

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Чанк PNG: длина данных, тип, данные, CRC по (тип + данные). */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function encodePng(size, rgba) {
  // Каждая строка изображения предваряется байтом фильтра. 0 = «без фильтра»:
  // сжатие чуть хуже, зато код тривиален, а иконки и так весят сотни байт.
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // бит на канал
  ihdr[9] = 6 // тип цвета 6 = truecolor + alpha
  ihdr[10] = 0 // сжатие deflate
  ihdr[11] = 0 // метод фильтрации
  ihdr[12] = 0 // без интерлейса

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// -------------------------------------------------------------------- запуск

const outDir = fileURLToPath(new URL('../public/icons/', import.meta.url))
mkdirSync(outDir, { recursive: true })

for (const size of SIZES) {
  const png = encodePng(size, render(size))
  writeFileSync(`${outDir}icon${size}.png`, png)
  console.log(`[icons] icon${size}.png — ${png.length} байт`)
}
