/**
 * Единая точка сборки расширения.
 *
 *   node scripts/build.mjs           — продакшн-сборка (mode=production)
 *   node scripts/build.mjs --watch   — режим разработки (mode=development)
 *
 * Почему свой скрипт, а не `vite build && vite build --config ...`:
 *   1. Нужно ГАРАНТИРОВАННО очистить dist ровно один раз перед обеими
 *      сборками. Если бы каждая сборка чистила dist сама (emptyOutDir),
 *      вторая стирала бы результат первой.
 *   2. В watch-режиме обе сборки должны работать параллельно и бесконечно.
 *      Через && это невозможно: вторая команда никогда не запустится.
 *   3. Нужно знать, когда ЛЮБАЯ из двух сборок закончилась, чтобы обновить
 *      файл dist/dev-build-id — по нему service worker понимает,
 *      что пора перезагрузить расширение (см. src/background/dev-reload.ts).
 */
import { rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const rootUrl = new URL('../', import.meta.url)
const root = fileURLToPath(rootUrl)
const distUrl = new URL('dist/', rootUrl)
const buildIdFile = fileURLToPath(new URL('dev-build-id', distUrl))

const watch = process.argv.includes('--watch')
const mode = watch ? 'development' : 'production'

const CONFIGS = ['vite.config.ts', 'vite.content.config.ts', 'vite.mlworker.config.ts']

/**
 * ВАЖНО: значение import.meta.env.DEV Vite берёт из NODE_ENV, а НЕ из mode.
 * Команда `build` по умолчанию выставляет NODE_ENV=production, поэтому при
 * `mode: 'development'` без этой строки import.meta.env.DEV всё равно был бы
 * false — и весь dev-код (в частности автоперезагрузка расширения) молча
 * вырезался бы из сборки. Симптом: `npm run dev` работает, но расширение
 * не перезагружается само, и никаких ошибок при этом нет.
 *
 * Vite импортируется динамически, ПОСЛЕ присваивания: статические импорты
 * поднимаются наверх файла и выполнились бы раньше него.
 */
process.env.NODE_ENV = mode
const { build } = await import('vite')

await rm(distUrl, { recursive: true, force: true })

// Модель и .wasm-бинарники копируются из node_modules в public/ до сборки:
// оттуда Vite положит их в dist как есть.
await import('./copy-assets.mjs')

if (!watch) {
  // Последовательно: обе сборки пишут в один dist, параллельный запуск
  // ради экономии пары секунд не стоит риска гонки за файлами.
  for (const configFile of CONFIGS) {
    await build({ root, configFile: fileURLToPath(new URL(configFile, rootUrl)), mode })
  }
  console.log('\n[build] Готово. Расширение собрано в dist/')
} else {
  console.log('[dev] Режим разработки, mode=development, слежение за файлами...')

  // Дребезг: две сборки заканчиваются с разницей в доли секунды.
  // Без дебаунса service worker перезагрузился бы дважды подряд.
  let timer = null
  const bumpBuildId = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      writeFile(buildIdFile, String(Date.now()), 'utf8').catch((error) => {
        console.error('[dev] Не удалось записать dev-build-id:', error)
      })
    }, 250)
  }

  for (const configFile of CONFIGS) {
    const watcher = await build({
      root,
      configFile: fileURLToPath(new URL(configFile, rootUrl)),
      mode,
      build: { watch: {} },
    })

    // build() с build.watch возвращает watcher, а не результат сборки.
    watcher.on('event', (event) => {
      if (event.code === 'END') bumpBuildId()
      if (event.code === 'ERROR') console.error('[dev] Ошибка сборки:', event.error)
    })
  }
}
