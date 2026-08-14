import * as tf from '@tensorflow/tfjs-core'
import { type GraphModel, loadGraphModel } from '@tensorflow/tfjs-converter'
import { type LayersModel, layers as tfLayers, loadLayersModel } from '@tensorflow/tfjs-layers'
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm'
import '@tensorflow/tfjs-backend-webgpu'
import { applyAlphaPlane, extractAlphaPlane } from '@/core/enhance/alpha'
import { applySharpening } from '@/core/enhance/canvas-enhancer'
import type {
  MlEnhanceRequest,
  MlInitRequest,
  MlModelSpec,
  MlRequest,
  MlResponse,
} from './ml-protocol'

/**
 * ML-апскейл на TensorFlow.js.
 *
 * Воркер не привязан к одной модели: всё, что их различает — коэффициент
 * увеличения, диапазон входа, наличие самописных слоёв, размер плитки —
 * приходит в запросе init. Общее у всех одно: полностью свёрточная сеть
 * с входом [batch, null, null, 3], принимающая картинку любого размера.
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
 * САМОПИСНЫЕ СЛОИ.
 *
 * Нужны не всем моделям. У RDN-вариантов (slim, medium) в model.json только
 * стандартные слои. У RRDN-варианта их два вида: MultiplyBeta встречается
 * сорок раз, PixelShuffle — один. Без регистрации ДО загрузки
 * loadLayersModel падает с «Unknown layer: MultiplyBeta».
 *
 * Реализация обязана повторять оригинал из пакета @upscalerjs: веса обучены
 * под конкретную математику, и другая даст визуальный мусор при формально
 * успешной загрузке.
 */

/** Коэффициент масштабирования остаточных блоков в ESRGAN. */
const RESIDUAL_BETA = 0.2

function firstInput(inputs: tf.Tensor | tf.Tensor[]): tf.Tensor {
  return Array.isArray(inputs) ? (inputs[0] as tf.Tensor) : inputs
}

class MultiplyBeta extends tfLayers.Layer {
  static className = 'MultiplyBeta'

  override call(inputs: tf.Tensor | tf.Tensor[]): tf.Tensor {
    return tf.mul(firstInput(inputs), RESIDUAL_BETA)
  }
}

/**
 * Имя класса включает коэффициент: в model.json слой записан как
 * PixelShuffle4x, и регистрировать его надо ровно под этим именем.
 * Поэтому класс создаётся фабрикой, а не пишется один раз.
 */
/*
 * Тип возвращаемого класса выводится, а не пишется явно: аннотация
 * `typeof Layer` теряет статическое поле className, без которого
 * registerClass не принимает класс.
 */
function createPixelShuffle(scale: number) {
  class PixelShuffle extends tfLayers.Layer {
    static className = `PixelShuffle${scale}x`

    override computeOutputShape(inputShape: number[] | number[][]): number[] {
      const shape = (Array.isArray(inputShape[0]) ? inputShape[0] : inputShape) as number[]
      return [shape[0] as number, shape[1] as number, shape[2] as number, 3]
    }

    override call(inputs: tf.Tensor | tf.Tensor[]): tf.Tensor {
      // depthToSpace — то, что в статьях называется sub-pixel convolution:
      // каналы «разворачиваются» в пространственное разрешение.
      return tf.depthToSpace(firstInput(inputs) as tf.Tensor4D, scale, 'NHWC')
    }
  }
  return PixelShuffle
}

const registeredLayers = new Set<string>()

function registerCustomLayers(scale: number): void {
  const key = `x${scale}`
  if (registeredLayers.has(key)) return
  // Повторная регистрация того же класса в TensorFlow.js — ошибка,
  // а воркер переиспользуется при смене модели.
  if (!registeredLayers.size) tf.serialization.registerClass(MultiplyBeta)
  tf.serialization.registerClass(createPixelShuffle(scale))
  registeredLayers.add(key)
}

/**
 * Две разные реализации, у которых совпадает ровно то, что нам нужно:
 * метод predict и свойство inputs. Общего базового типа у них нет,
 * поэтому объединение.
 */
type AnyModel = LayersModel | GraphModel

let model: AnyModel | null = null
let spec: MlModelSpec | null = null
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

/**
 * @param size сторона прогревочного квадрата. У моделей с зафиксированной
 *             формой входа он обязан совпадать с ней — иначе прогрев упадёт.
 */
async function warmUp(loaded: AnyModel, size: number): Promise<void> {
  const probe = tf.zeros([1, size, size, 3])
  const output = loaded.predict(probe) as tf.Tensor
  // dataSync дожидается фактического выполнения: без него на GPU-бэкенде
  // работа осталась бы в очереди, и прогрев ничего бы не прогрел.
  output.dataSync()
  probe.dispose()
  output.dispose()
}

/** Полная сторона плитки, которая уходит в модель: сердцевина плюс поля с двух сторон. */
function windowSize(current: MlModelSpec): number {
  return current.tileSize + 2 * current.tileOverlap
}

/**
 * Сверка формы входа с тем, что записано в реестре моделей.
 *
 * Проверка дешёвая, а ошибка без неё дорогая: несовпадение проявилось бы
 * отказом на первой же плитке, то есть уже после загрузки весов и прогрева,
 * и в сообщении «shape must be [1,64,64,3]» не было бы ни слова о том,
 * что чинить надо реестр.
 */
function assertInputShape(loaded: AnyModel, current: MlModelSpec): void {
  if (!current.fixedInputSize) return
  const shape = loaded.inputs[0]?.shape
  const expected = windowSize(current)
  const actual = shape?.[1]
  if (typeof actual === 'number' && actual !== expected) {
    throw new Error(
      `Модель ждёт вход ${actual}×${actual}, а плитка собрана ${expected}×${expected}. ` +
        'Поправьте tileSize и tileOverlap в реестре моделей: их сумма с полями ' +
        'обязана давать ровно размер входа модели.',
    )
  }
}

async function init(request: MlInitRequest): Promise<MlResponse> {
  const startedAt = performance.now()
  try {
    spec = request.model
    if (spec.customLayers) registerCustomLayers(spec.scale)
    activeBackend = await selectBackend(request)
    /**
     * Загрузчик свой у каждого формата. loadLayersModel на graph-модели
     * падает с невнятным «Cannot read properties of undefined»: он ищет
     * в model.json описание слоёв, которого там нет.
     */
    model =
      spec.format === 'graph' ? await loadGraphModel(spec.url) : await loadLayersModel(spec.url)
    assertInputShape(model, spec)
    await warmUp(model, spec.fixedInputSize ? windowSize(spec) : WARMUP_SIZE)
    return {
      type: 'ready',
      backend: activeBackend,
      loadMs: Math.round(performance.now() - startedAt),
      scale: spec.scale,
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
  const inputMax = spec?.inputMax ?? 255

  const output = tf.tidy(() => {
    /**
     * ДИАПАЗОН ВХОДА — свойство конкретной модели, а не общее правило.
     *
     * У RDN-вариантов (slim, medium) он 0..255, у RRDN — 0..1. Это записано
     * в исходниках пакета @upscalerjs и никак не следует из самих весов.
     *
     * Ошибка здесь НЕ даёт очевидного мусора, и это самое коварное:
     * у обеих архитектур есть глобальный residual, и при неверно
     * отмасштабированном входе сеть вырождается примерно в обычное
     * растяжение. Картинка выглядит нормально, средний цвет сохраняется —
     * просто модель не работает. Подробный разбор — в гайде этапа 5.
     */
    const pixels = tf.browser.fromPixels(tile)
    const scaled =
      inputMax === 255
        ? tf.cast(pixels, 'float32')
        : tf.div(tf.cast(pixels, 'float32'), 255 / inputMax)
    const batched = tf.expandDims(scaled, 0)
    const predicted = model!.predict(batched) as tf.Tensor
    // Сеть может выдать значения за пределами диапазона, и без обрезки
    // они завернулись бы при переводе в байты.
    const clipped = tf.clipByValue(tf.squeeze(predicted, [0]), 0, inputMax)
    // toPixels ожидает float в 0..1 либо int32 в 0..255.
    return tf.div(clipped, inputMax) as tf.Tensor3D
  })

  const pixels = await tf.browser.toPixels(output)
  output.dispose()
  return pixels
}

/**
 * Сбор плитки постоянного размера с дополнением краёв.
 *
 * Окно [wx, wy, size × size] может выходить за границы картинки — у краевых
 * плиток это норма. Существующая часть рисуется на своё место, а недостающие
 * поля заполняются растягиванием крайнего ряда пикселей наружу.
 *
 * Почему именно растягивание, а не нули и не зеркало:
 *   нули — сеть увидела бы у края чёрную рамку и достроила по ней контраст,
 *          которого нет; это видно как тёмная кайма по периметру картинки;
 *   зеркало — правильнее по спектру, но требует попиксельного копирования,
 *          а тут сотни плиток на картинку;
 *   растягивание — четыре вызова drawImage, и край получается ровно таким,
 *          каким сеть его и так считает продолжением.
 *
 * Порядок вызовов не случаен: сначала верх и низ на ширину сердцевины,
 * потом лево и право на всю высоту — так углы заполняются сами,
 * без отдельного случая для каждого из четырёх.
 */
function padWindow(
  ctx: OffscreenCanvasRenderingContext2D,
  source: OffscreenCanvas,
  wx: number,
  wy: number,
  size: number,
  imageWidth: number,
  imageHeight: number,
): void {
  const sx = Math.max(0, wx)
  const sy = Math.max(0, wy)
  const sw = Math.min(imageWidth, wx + size) - sx
  const sh = Math.min(imageHeight, wy + size) - sy
  const dx = sx - wx
  const dy = sy - wy

  ctx.clearRect(0, 0, size, size)
  ctx.drawImage(source, sx, sy, sw, sh, dx, dy, sw, sh)

  if (dy > 0) ctx.drawImage(ctx.canvas, dx, dy, sw, 1, dx, 0, sw, dy)
  const below = size - (dy + sh)
  if (below > 0) ctx.drawImage(ctx.canvas, dx, dy + sh - 1, sw, 1, dx, dy + sh, sw, below)
  if (dx > 0) ctx.drawImage(ctx.canvas, dx, 0, 1, size, 0, 0, dx, size)
  const right = size - (dx + sw)
  if (right > 0) ctx.drawImage(ctx.canvas, dx + sw - 1, 0, 1, size, dx + sw, 0, right, size)
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
  if (!model || !spec) return { type: 'failed', id: request.id, error: 'Модель не загружена' }

  const startedAt = performance.now()
  const source = request.bitmap
  const { scale, tileSize: TILE_SIZE, tileOverlap: TILE_OVERLAP, fixedInputSize } = spec
  const WINDOW = windowSize(spec)
  try {
    const width = source.width
    const height = source.height

    const sourceCanvas = new OffscreenCanvas(width, height)
    const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true })
    if (!sourceContext) throw new Error('Не удалось получить контекст 2d')
    sourceContext.drawImage(source, 0, 0)

    /**
     * Альфа снимается ДО модели и возвращается ПОСЛЕ.
     *
     * Модель принимает три канала; четвёртый она не увидит, а на выходе
     * поставит 255. Без этой пары строк прозрачный логотип возвращался бы
     * непрозрачным — см. src/core/enhance/alpha.ts.
     */
    const alphaPlane = extractAlphaPlane(
      sourceContext.getImageData(0, 0, width, height),
    )

    const outCanvas = new OffscreenCanvas(width * scale, height * scale)
    const outContext = outCanvas.getContext('2d')
    if (!outContext) throw new Error('Не удалось получить контекст 2d')

    /**
     * Холст под плитку постоянного размера. Нужен только моделям
     * с зафиксированной формой входа, поэтому создаётся по требованию
     * и переиспользуется всеми плитками: их бывают сотни.
     */
    const padCanvas = fixedInputSize ? new OffscreenCanvas(WINDOW, WINDOW) : null
    const padContext = padCanvas?.getContext('2d', { willReadFrequently: true }) ?? null
    if (padCanvas && !padContext) throw new Error('Не удалось получить контекст 2d')

    for (let y = 0; y < height; y += TILE_SIZE) {
      for (let x = 0; x < width; x += TILE_SIZE) {
        const tileWidth = Math.min(TILE_SIZE, width - x)
        const tileHeight = Math.min(TILE_SIZE, height - y)

        let tile: ImageData
        let windowX: number
        let windowY: number
        let windowW: number
        let windowH: number
        let offsetX: number
        let offsetY: number

        if (padContext) {
          /**
           * Окно всегда одного размера и всегда с полями со всех сторон,
           * даже у самого края картинки, где полей взять неоткуда.
           * Недостающее дополняется растягиванием краевых пикселей —
           * это не «правильное» продолжение картинки, но лучшее из дешёвых:
           * нулевые поля дали бы сети чёрную рамку, и она достроила бы
           * по ней несуществующий контраст.
           */
          windowX = x - TILE_OVERLAP
          windowY = y - TILE_OVERLAP
          windowW = WINDOW
          windowH = WINDOW
          offsetX = TILE_OVERLAP
          offsetY = TILE_OVERLAP
          padWindow(padContext, sourceCanvas, windowX, windowY, WINDOW, width, height)
          tile = padContext.getImageData(0, 0, WINDOW, WINDOW)
        } else {
          // Свободная форма входа: проще обрезать поля по краям картинки,
          // чем что-то дорисовывать.
          const padLeft = Math.min(TILE_OVERLAP, x)
          const padTop = Math.min(TILE_OVERLAP, y)
          const padRight = Math.min(TILE_OVERLAP, width - (x + tileWidth))
          const padBottom = Math.min(TILE_OVERLAP, height - (y + tileHeight))
          windowX = x - padLeft
          windowY = y - padTop
          windowW = tileWidth + padLeft + padRight
          windowH = tileHeight + padTop + padBottom
          offsetX = padLeft
          offsetY = padTop
          tile = sourceContext.getImageData(windowX, windowY, windowW, windowH)
        }

        const resultPixels = await inferTile(tile)

        // createImageData + set вместо конструктора ImageData: конструктор
        // требует буфер строго типа ArrayBuffer, а toPixels возвращает массив
        // поверх ArrayBufferLike, и типы не сходятся.
        const resultData = outContext.createImageData(windowW * scale, windowH * scale)
        resultData.data.set(resultPixels)

        /**
         * putImageData с прямоугольником: из результата берётся только
         * центральная часть, поля отбрасываются. Поля существуют ровно
         * для этого — свёртки у края плитки видят «обрыв» изображения
         * и дают там искажения, которые на стыке плиток сложились бы
         * в видимую сетку.
         *
         * Начало кладётся по окну, а вырезка отсчитывается от него же,
         * поэтому отрицательное windowX у краевой плитки не мешает:
         * итоговое место всё равно выходит x * scale.
         */
        outContext.putImageData(
          resultData,
          windowX * scale,
          windowY * scale,
          offsetX * scale,
          offsetY * scale,
          tileWidth * scale,
          tileHeight * scale,
        )
      }
    }

    /**
     * Маскирование применяется к СОБРАННОМУ холсту, а не к каждой плитке.
     * По плиткам оно дало бы видимую сетку: у краёв плитки размытие
     * считалось бы по неполному окружению.
     */
    applySharpening(outCanvas, request.sharpen)

    // Последним шагом: маскирование альфу не трогает, но холст перечитывает,
    // и вклиниваться между ними незачем.
    if (alphaPlane) applyAlphaPlane(outCanvas, alphaPlane)

    const blob = await outCanvas.convertToBlob({ type: 'image/png' })

    return {
      type: 'done',
      id: request.id,
      blob,
      width: width * scale,
      height: height * scale,
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
