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

/** Модель увеличивает ровно вдвое, остальные варианты пакета не нужны. */
const MODEL_VARIANT = 'x2'

const modelSource = new URL(`node_modules/@upscalerjs/esrgan-slim/models/${MODEL_VARIANT}/`, root)
const modelTarget = new URL('public/models/esrgan-slim-x2/', root)

const wasmSource = new URL('node_modules/@tensorflow/tfjs-backend-wasm/dist/', root)
const wasmTarget = new URL('public/wasm/', root)

await rm(modelTarget, { recursive: true, force: true })
await rm(wasmTarget, { recursive: true, force: true })
await mkdir(modelTarget, { recursive: true })
await mkdir(wasmTarget, { recursive: true })

// model.json ссылается на файл весов по относительному имени, поэтому оба
// файла обязаны лежать рядом.
await cp(modelSource, modelTarget, { recursive: true })

/**
 * Бинарников три: базовый, с SIMD и с SIMD+потоками. Бэкенд сам выбирает
 * нужный в рантайме по возможностям браузера, поэтому нужны все.
 */
const wasmFiles = (await readdir(fileURLToPath(wasmSource))).filter((name) => name.endsWith('.wasm'))
for (const name of wasmFiles) {
  await cp(new URL(name, wasmSource), new URL(name, wasmTarget))
}

console.log(
  `[assets] модель esrgan-slim-${MODEL_VARIANT} и ${wasmFiles.length} .wasm скопированы в public/`,
)
