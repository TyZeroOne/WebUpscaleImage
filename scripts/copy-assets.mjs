/**
 * Копирование бинарных ресурсов из node_modules в public/.
 *
 * Копируются:
 *   - веса и топология модели ESRGAN-slim x2 (@upscalerjs/esrgan-slim, MIT);
 *   - .wasm-бинарники бэкенда TensorFlow.js.
 *
 * Почему копируем при сборке, а не коммитим в репозиторий: это чужие
 * артефакты, у них есть версия в package.json, и держать их вторую копию
 * в истории git значит гарантированно однажды получить расхождение
 * между версией пакета и версией файла.
 *
 * Почему вообще кладём в пакет расширения, а не грузим при первом
 * использовании: требование проекта — картинки пользователя не покидают
 * машину. Самый надёжный способ это гарантировать — не иметь сетевых
 * запросов в момент работы вообще.
 */
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)

/**
 * Все три модели кладутся в пакет, чтобы переключение шло без сети.
 * Веса: slim — 0.9 МБ, medium — 2.7 МБ, gans — 4.5 МБ.
 *
 * Варианта esrgan-thick здесь нет намеренно: его пакет весит 120 МБ,
 * а нужная часть — порядка двух десятков мегабайт. Это больше, чем всё
 * остальное расширение вместе взятое, ради модели, которая на машине
 * без WebGPU всё равно неприменима по времени.
 */
const MODELS = [
  { pkg: 'esrgan-slim', variant: 'x2', out: 'esrgan-slim-x2' },
  { pkg: 'esrgan-medium', variant: 'x2', out: 'esrgan-medium-x2' },
  { pkg: 'esrgan-legacy', variant: 'gans', out: 'esrgan-gans-x4' },
]

const modelsTarget = new URL('public/models/', root)
const wasmSource = new URL('node_modules/@tensorflow/tfjs-backend-wasm/dist/', root)
const wasmTarget = new URL('public/wasm/', root)

await rm(modelsTarget, { recursive: true, force: true })
await rm(wasmTarget, { recursive: true, force: true })
await mkdir(modelsTarget, { recursive: true })
await mkdir(wasmTarget, { recursive: true })

for (const model of MODELS) {
  const source = new URL(`node_modules/@upscalerjs/${model.pkg}/models/${model.variant}/`, root)
  const target = new URL(`${model.out}/`, modelsTarget)
  await mkdir(target, { recursive: true })
  // model.json ссылается на файл весов по относительному имени, поэтому оба
  // файла обязаны лежать рядом.
  await cp(source, target, { recursive: true })
}

/**
 * Бинарников три: базовый, с SIMD и с SIMD+потоками. Бэкенд сам выбирает
 * нужный в рантайме по возможностям браузера, поэтому нужны все.
 */
const wasmFiles = (await readdir(fileURLToPath(wasmSource))).filter((name) => name.endsWith('.wasm'))
for (const name of wasmFiles) {
  await cp(new URL(name, wasmSource), new URL(name, wasmTarget))
}

console.log(
  `[assets] модели ${MODELS.map((m) => m.out).join(', ')} и ${wasmFiles.length} .wasm скопированы в public/`,
)
