import * as tf from '@tensorflow/tfjs-core'
import { type LayersModel, loadLayersModel } from '@tensorflow/tfjs-layers'
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm'
import '@tensorflow/tfjs-backend-webgpu'
import {
  ML_SCALE,
  type MlEnhanceRequest,
  type MlInitRequest,
  type MlRequest,
  type MlResponse,
} from './ml-protocol'

/**
 * ML-апскейл на TensorFlow.js.
 *
 * Модель — ESRGAN-slim x2 из пакета @upscalerjs/esrgan-slim (MIT). Она
 * полностью свёрточная (вход [batch, null, null, 3]), поэтому принимает
 * картинку любого размера, а увеличение вдвое зашито в архитектуру
 * последним слоем PixelShuffle.
 *
 * Воркер собирается ОТДЕЛЬНОЙ конфигурацией (vite.mlworker.config.ts)
 * в самостоятельный файл dist/ml-worker.js, а не встраивается в content.js.
 * Причина простая: вместе с TensorFlow.js и обоими бэкендами это мегабайты,
 * а content.js внедряется в каждую открытую страницу. Файл загружается
 * лениво — только когда пользователь впервые попросил ML-обработку.
 */

/**
 * Размер прогревочного прогона.
 *
 * Первый инференс всегда дороже остальных: бэкенд компилирует шейдеры
 * (WebGPU) или инстанцирует модуль WebAssembly, и делается это лениво,
 * при первом вызове ядра. Без прогрева эта плата легла бы на первую
 * настоящую картинку пользователя и выглядела бы как «первый раз тормозит».
 *
 * 16×16 достаточно: нужны сами ядра, а не осмысленный результат.
 */
const WARMUP_SIZE = 16

/**
 * Сторона плитки, на которые режется картинка перед инференсом.
 *
 * 224 подобрано по замерам: с полями получается вход не больше 272×272
 * (74 тысячи пикселей), а падать WebGPU начинал при 691 тысяче. Запас
 * шестикратный — на другие видеокарты с более строгими лимитами.
 *
 * Меньше делать невыгодно: у каждого вызова модели есть постоянные
 * накладные расходы, и на WebGPU они заметно больше самих вычислений
 * (замер: 120 тыс. пикселей — 164 мс, 307 тыс. — 189 мс, то есть
 * двукратный рост объёма стоил 15% времени).
 */
const TILE_SIZE = 224

/**
 * Ширина полей вокруг плитки, которые считаются и выбрасываются.
 *
 * Свёртки с padding='same' у края плитки видят «обрыв» изображения
 * и достраивают его нулями — результат у границы искажается. Без полей
 * эти искажения сложились бы в видимую сетку по стыкам.
 *
 * Величина определяется рецептивным полем сети: у ESRGAN-slim около
 * десятка свёрток 3×3, каждая расширяет зону влияния на 1 пиксель
 * в каждую сторону, итого ~10-12. Взято 24 — двойной запас.
 */
const TILE_OVERLAP = 24

/**
 * КАСТОМНЫХ СЛОЁВ ЗДЕСЬ НЕТ — и это выяснилось не сразу.
 *
 * Пакет @upscalerjs/esrgan-slim умеет две архитектуры. Для собственно
 * ESRGAN он регистрирует два самописных слоя (MultiplyBeta и PixelShuffle),
 * без которых loadLayersModel падает с «Unknown layer». Но вариант x2,
 * который мы используем, объявлен как architecture: 'rdn', и в его
 * model.json таких слоёв нет: только Conv2D, Add, Concatenate, Activation
 * и UpSampling2D — всё из стандартного набора TensorFlow.js.
 *
 * Если однажды модель поменяется на не-RDN, слои придётся описать
 * и зарегистрировать через tf.serialization.registerClass ДО загрузки.
 */

let model: LayersModel | null = null
let activeBackend = ''

/**
 * Выбор бэкенда.
 *
 * WebGPU быстрее WASM на порядок и более, но доступен не везде: нужен
 * поддерживаемый драйвер и видеокарта не из чёрного списка. Проверка
 * «есть ли navigator.gpu» этого не гарантирует — только реальная попытка
 * инициализации.
 *
 * Отсюда порядок: пробуем WebGPU, если не получилось — WASM. Молча,
 * без ошибки пользователю: для него это разница в скорости, а не в работе.
 */
async function selectBackend(request: MlInitRequest): Promise<string> {
  if (request.preferWebgpu) {
    try {
      await tf.setBackend('webgpu')
      await tf.ready()
      if (tf.getBackend() === 'webgpu') return 'webgpu'
    } catch {
      // Проглатываем: ниже отработает WASM.
    }
  }

  /**
   * Путь к .wasm обязательно задаётся до setBackend('wasm'): бэкенд
   * скачивает бинарник при инициализации, и по умолчанию ищет его рядом
   * с собой — то есть по blob-URL, где ничего нет.
   */
  setWasmPaths(request.wasmBaseUrl)
  await tf.setBackend('wasm')
  await tf.ready()
  return tf.getBackend()
}

async function warmUp(loaded: LayersModel): Promise<void> {
  const probe = tf.zeros([1, WARMUP_SIZE, WARMUP_SIZE, 3])
  const output = loaded.predict(probe) as tf.Tensor
  // dataSync дожидается фактического выполнения: без него на GPU-бэкенде
  // работа осталась бы в очереди, и прогрев ничего бы не прогрел.
  output.dataSync()
  probe.dispose()
  output.dispose()
}

async function init(request: MlInitRequest): Promise<MlResponse> {
  const startedAt = performance.now()
  try {
    activeBackend = await selectBackend(request)
    model = await loadLayersModel(request.modelUrl)
    await warmUp(model)
    return {
      type: 'ready',
      backend: activeBackend,
      loadMs: Math.round(performance.now() - startedAt),
    }
  } catch (error) {
    return { type: 'init-failed', error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Прогон одной плитки через модель. Возвращает пиксели RGBA увеличенной плитки.
 *
 * Функциональный API (tf.div), а не цепочечный (tensor.div): цепочечные
 * методы в @tensorflow/tfjs-core не зарегистрированы, они подключаются
 * отдельным импортом и есть только в полном пакете @tensorflow/tfjs.
 *
 * tf.tidy освобождает все промежуточные тензоры: у TensorFlow.js нет
 * сборщика мусора для них, они живут до явного dispose. Без tidy каждая
 * плитка оставляла бы в памяти десятки буферов.
 */
async function inferTile(tile: ImageData): Promise<Uint8ClampedArray> {
  const output = tf.tidy(() => {
    /**
     * ДИАПАЗОН ВХОДА — 0..255, а не 0..1.
     *
     * Это свойство конкретной модели, а не общее правило: в исходниках
     * @upscalerjs/esrgan-slim у архитектуры 'rdn' объявлено
     * inputRange: [0, 255], тогда как у собственно ESRGAN — [0, 1].
     * Пакет называется esrgan-slim, но веса внутри — RDN (это видно
     * и по именам слоёв в model.json: RDB_Concat, LFF, GFF, LRL).
     *
     * Ошибка здесь НЕ даёт очевидного мусора, и это самое коварное:
     * у RDN есть глобальный residual, и при заниженном в 255 раз входе
     * сеть вырождается примерно в обычное растяжение. Картинка выглядит
     * нормально, средний цвет сохраняется — просто модель не работает.
     */
    const pixels = tf.browser.fromPixels(tile)
    const batched = tf.expandDims(tf.cast(pixels, 'float32'), 0)
    const predicted = model!.predict(batched) as tf.Tensor
    // Сеть может выдать значения за пределами 0..255, и без обрезки
    // они завернулись бы при переводе в байты.
    const clipped = tf.clipByValue(tf.squeeze(predicted, [0]), 0, 255)
    // toPixels ожидает float в 0..1 либо int32 в 0..255.
    return tf.div(clipped, 255) as tf.Tensor3D
  })

  const pixels = await tf.browser.toPixels(output)
  output.dispose()
  return pixels
}

/**
 * Обработка плитками.
 *
 * Целиком картинку в модель отправлять нельзя. Замеры показали жёсткий
 * потолок у WebGPU-бэкенда: на входе 960×720 инференс падает с ошибкой
 * «Dispatch size exceeds WebGPU limits in Y or Z dimension» — размер
 * вычислительной сетки упирается в лимит устройства. На WASM ограничение
 * другое, но не менее реальное: время растёт линейно по пикселям,
 * и мегапиксель считался бы около десяти секунд.
 *
 * Плитки решают обе задачи разом: расход памяти и размер каждого вызова
 * фиксированы и не зависят от размера картинки.
 */
async function enhance(request: MlEnhanceRequest): Promise<MlResponse> {
  if (!model) return { type: 'failed', id: request.id, error: 'Модель не загружена' }

  const startedAt = performance.now()
  const source = request.bitmap
  try {
    const width = source.width
    const height = source.height

    const sourceCanvas = new OffscreenCanvas(width, height)
    const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true })
    if (!sourceContext) throw new Error('Не удалось получить контекст 2d')
    sourceContext.drawImage(source, 0, 0)

    const outCanvas = new OffscreenCanvas(width * ML_SCALE, height * ML_SCALE)
    const outContext = outCanvas.getContext('2d')
    if (!outContext) throw new Error('Не удалось получить контекст 2d')

    for (let y = 0; y < height; y += TILE_SIZE) {
      for (let x = 0; x < width; x += TILE_SIZE) {
        const tileWidth = Math.min(TILE_SIZE, width - x)
        const tileHeight = Math.min(TILE_SIZE, height - y)

        // Поля добавляются со всех сторон и обрезаются по краям картинки.
        const padLeft = Math.min(TILE_OVERLAP, x)
        const padTop = Math.min(TILE_OVERLAP, y)
        const padRight = Math.min(TILE_OVERLAP, width - (x + tileWidth))
        const padBottom = Math.min(TILE_OVERLAP, height - (y + tileHeight))

        const paddedWidth = tileWidth + padLeft + padRight
        const paddedHeight = tileHeight + padTop + padBottom

        const tile = sourceContext.getImageData(x - padLeft, y - padTop, paddedWidth, paddedHeight)
        const resultPixels = await inferTile(tile)

        // createImageData + set вместо конструктора ImageData: конструктор
        // требует буфер строго типа ArrayBuffer, а toPixels возвращает массив
        // поверх ArrayBufferLike, и типы не сходятся.
        const resultData = outContext.createImageData(
          paddedWidth * ML_SCALE,
          paddedHeight * ML_SCALE,
        )
        resultData.data.set(resultPixels)

        /**
         * putImageData с прямоугольником: из результата берётся только
         * центральная часть, поля отбрасываются. Поля существуют ровно
         * для этого — свёртки у края плитки видят «обрыв» изображения
         * и дают там искажения, которые на стыке плиток сложились бы
         * в видимую сетку.
         */
        outContext.putImageData(
          resultData,
          (x - padLeft) * ML_SCALE,
          (y - padTop) * ML_SCALE,
          padLeft * ML_SCALE,
          padTop * ML_SCALE,
          tileWidth * ML_SCALE,
          tileHeight * ML_SCALE,
        )
      }
    }

    const blob = await outCanvas.convertToBlob({ type: 'image/png' })

    return {
      type: 'done',
      id: request.id,
      blob,
      width: width * ML_SCALE,
      height: height * ML_SCALE,
      durationMs: Math.round(performance.now() - startedAt),
      backend: activeBackend,
    }
  } catch (error) {
    return {
      type: 'failed',
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    // Владение картинкой перешло сюда вместе с transfer.
    source.close()
  }
}

/**
 * Минимальное описание области видимости воркера: библиотека типов
 * "WebWorker" конфликтует с "DOM" в пределах одного tsconfig.
 */
interface WorkerScope {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

const scope = self as unknown as WorkerScope

scope.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as MlRequest
  void (async () => {
    const response = request.type === 'init' ? await init(request) : await enhance(request)
    scope.postMessage(response)
  })()
})
