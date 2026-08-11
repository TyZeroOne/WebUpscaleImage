/**
 * Упаковка расширения для публикации в Chrome Web Store.
 *
 * Делает две вещи, и вторая важнее первой:
 *   1. Проверяет собранный пакет — ошибки, которые магазин найдёт при загрузке,
 *      дешевле найти здесь.
 *   2. Складывает dist/ в zip.
 *
 * Zip пишется вручную. Готовых архиваторов в зависимостях нет, и тащить их
 * ради одной команды не хочется: формат в минимальном варианте — три структуры,
 * а deflate есть в стандартной библиотеке Node. Тот же расчёт, что с PNG
 * на этапе 0.
 */
import { deflateRawSync } from 'node:zlib'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const rootUrl = new URL('../', import.meta.url)
const distDir = fileURLToPath(new URL('dist/', rootUrl))

// ------------------------------------------------------------------ проверки

const problems = []
const warnings = []

function fail(message) {
  problems.push(message)
}

/**
 * Чтение JSON с отбрасыванием BOM.
 *
 * JSON.parse на файле с меткой порядка байтов падает с невнятным
 * «Unexpected token», указывая на первый символ. Редакторы под Windows
 * ставят BOM охотно, а messages.json правят руками чаще любого другого
 * файла в проекте — падать на этом проверялка не должна.
 */
async function readJson(path) {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''))
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Все файлы внутри dist, путями относительно неё и со слешами. */
async function collectFiles(dir = distDir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const name = `${prefix}${entry.name}`
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(`${dir}${entry.name}/`, `${name}/`)))
    } else {
      files.push(name)
    }
  }
  return files.sort()
}

if (!(await exists(distDir))) {
  console.error('[package] Нет папки dist. Сначала выполните npm run build.')
  process.exit(1)
}

const files = await collectFiles()
const manifest = await readJson(`${distDir}manifest.json`)
const pkg = await readJson(fileURLToPath(new URL('package.json', rootUrl)))

/**
 * Версия в манифесте — источник истины (её показывает магазин), но расходиться
 * с package.json она не должна: иначе однажды выложится сборка, номер которой
 * ни с чем не совпадает.
 */
if (manifest.version !== pkg.version) {
  fail(`Версии разошлись: manifest ${manifest.version}, package.json ${pkg.version}`)
}

/** Все пути, на которые ссылается манифест, должны существовать. */
const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...(manifest.content_scripts ?? []).flatMap((entry) => [...(entry.js ?? []), ...(entry.css ?? [])]),
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
].filter(Boolean)

for (const path of new Set(referenced)) {
  if (!files.includes(path)) fail(`Манифест ссылается на отсутствующий файл: ${path}`)
}

/**
 * Ресурсы, объявленные доступными странице, тоже должны существовать —
 * но там шаблоны со звёздочкой, поэтому проверяем по префиксу.
 */
for (const rule of manifest.web_accessible_resources ?? []) {
  for (const pattern of rule.resources ?? []) {
    const prefix = pattern.replace(/\*+$/, '')
    if (!files.some((file) => file.startsWith(prefix))) {
      fail(`web_accessible_resources: под шаблон "${pattern}" не подходит ни один файл`)
    }
  }
}

/**
 * Локали должны совпадать по набору ключей.
 *
 * Пропущенный ключ не ломает сборку и не выдаёт ошибку: chrome.i18n вернёт
 * пустую строку, и в интерфейсе просто исчезнет надпись. Найти такое глазами
 * можно только переключив язык браузера и просмотрев все экраны.
 */
const localeDirs = files
  .filter((file) => file.startsWith('_locales/') && file.endsWith('/messages.json'))
  .map((file) => file.split('/')[1])

if (manifest.default_locale && !localeDirs.includes(manifest.default_locale)) {
  fail(`default_locale "${manifest.default_locale}" объявлен, но такой локали нет`)
}

const localeKeys = new Map()
for (const locale of localeDirs) {
  const messages = await readJson(`${distDir}_locales/${locale}/messages.json`)
  localeKeys.set(locale, new Set(Object.keys(messages)))

  /**
   * Плейсхолдеры должны совпадать с тем, что стоит в тексте.
   *
   * Chrome такие расхождения ИГНОРИРУЕТ: незнакомый $NAME$ он оставляет
   * в строке как есть, а лишнее объявление просто не использует.
   * В интерфейсе это выглядит как «Готово: $SIZE$, 4.2 МБ» — заметить
   * можно только глазами и только на нужном языке.
   */
  for (const [key, entry] of Object.entries(messages)) {
    const used = new Set(
      [...String(entry.message).matchAll(/\$([A-Z0-9_]+)\$/g)].map((match) => match[1]),
    )
    const declared = new Set(Object.keys(entry.placeholders ?? {}).map((name) => name.toUpperCase()))

    for (const name of used) {
      if (!declared.has(name)) fail(`${locale}/${key}: в тексте есть $${name}$, но он не объявлен`)
    }
    for (const name of declared) {
      if (!used.has(name)) fail(`${locale}/${key}: плейсхолдер ${name} объявлен, но не используется`)
    }
  }
}
const [reference, ...others] = [...localeKeys.keys()]
if (reference) {
  for (const locale of others) {
    for (const key of localeKeys.get(reference)) {
      if (!localeKeys.get(locale).has(key)) fail(`В локали ${locale} нет ключа "${key}"`)
    }
    for (const key of localeKeys.get(locale)) {
      if (!localeKeys.get(reference).has(key)) fail(`В локали ${reference} нет ключа "${key}"`)
    }
  }
}

/** Следы разработки не должны попасть в публикуемый пакет. */
if (files.includes('dev-build-id')) fail('В пакете остался dev-build-id — соберите через npm run build')
for (const file of files) {
  if (file.endsWith('.map')) fail(`В пакете остался sourcemap: ${file}`)
}

/**
 * Размер. Жёсткого лимита у магазина нет для распакованного содержимого,
 * но пакет крупнее сотни мегабайт он не примет, а всё, что заметно больше
 * десятка, стоит объяснить в описании.
 */
let totalBytes = 0
for (const file of files) totalBytes += (await stat(`${distDir}${file}`)).size
if (totalBytes > 100 * 1024 * 1024) fail('Пакет больше 100 МБ — магазин его не примет')
if (totalBytes > 10 * 1024 * 1024) {
  warnings.push(`Пакет весит ${(totalBytes / 1024 / 1024).toFixed(1)} МБ — крупно для расширения`)
}

for (const warning of warnings) console.warn(`[package] ВНИМАНИЕ: ${warning}`)
if (problems.length > 0) {
  for (const problem of problems) console.error(`[package] ОШИБКА: ${problem}`)
  process.exit(1)
}

// -------------------------------------------------------------------- zip

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

/**
 * Фиксированная метка времени вместо текущей.
 *
 * Даёт воспроизводимую сборку: два запуска на одном коде дают побайтово
 * одинаковый архив. Это позволяет проверить, что выложенное совпадает
 * с исходниками, и не создаёт бессмысленных различий при сравнении версий.
 *
 * Формат DOS: дата и время упакованы в два 16-битных числа, отсчёт лет
 * от 1980. Здесь зашито 2020-01-01 00:00.
 */
const DOS_TIME = 0
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1

const localParts = []
const centralParts = []
let offset = 0

for (const name of files) {
  const content = await readFile(`${distDir}${name}`)
  const compressed = deflateRawSync(content, { level: 9 })
  const nameBytes = Buffer.from(name, 'utf8')
  const crc = crc32(content)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0) // сигнатура локального заголовка
  local.writeUInt16LE(20, 4) // минимальная версия для распаковки
  local.writeUInt16LE(0, 6) // флаги
  local.writeUInt16LE(8, 8) // метод сжатия: deflate
  local.writeUInt16LE(DOS_TIME, 10)
  local.writeUInt16LE(DOS_DATE, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(content.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  local.writeUInt16LE(0, 28) // extra
  localParts.push(local, nameBytes, compressed)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0) // сигнатура записи каталога
  central.writeUInt16LE(20, 4) // версия создателя
  central.writeUInt16LE(20, 6) // минимальная версия
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt16LE(DOS_TIME, 12)
  central.writeUInt16LE(DOS_DATE, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(content.length, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt16LE(0, 30) // extra
  central.writeUInt16LE(0, 32) // комментарий
  central.writeUInt16LE(0, 34) // номер диска
  central.writeUInt16LE(0, 36) // внутренние атрибуты
  central.writeUInt32LE(0, 38) // внешние атрибуты
  central.writeUInt32LE(offset, 42) // смещение локального заголовка
  centralParts.push(central, nameBytes)

  offset += local.length + nameBytes.length + compressed.length
}

const centralDirectory = Buffer.concat(centralParts)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0) // сигнатура конца каталога
end.writeUInt16LE(0, 4) // номер диска
end.writeUInt16LE(0, 6) // диск с каталогом
end.writeUInt16LE(files.length, 8) // записей на этом диске
end.writeUInt16LE(files.length, 10) // всего записей
end.writeUInt32LE(centralDirectory.length, 12)
end.writeUInt32LE(offset, 16)
end.writeUInt16LE(0, 20) // комментарий архива

const archive = Buffer.concat([...localParts, centralDirectory, end])
const outName = `image-enhancer-${manifest.version}.zip`
await writeFile(fileURLToPath(new URL(outName, rootUrl)), archive)

console.log(
  `[package] ${outName}: ${files.length} файлов, ` +
    `${(totalBytes / 1024 / 1024).toFixed(1)} МБ -> ${(archive.length / 1024 / 1024).toFixed(1)} МБ`,
)
