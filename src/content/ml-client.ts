import type { EnhanceResult } from '@/core/enhance'
import { createLogger } from '@/core/log'
import type { ModelChoice } from '@/core/settings'
import {
  ML_MIN_SCALE,
  type MlEnhanceRequest,
  type MlInitRequest,
  type MlResponse,
} from '@/workers/ml-protocol'

/**
 * Клиент ML-воркера.
 *
 * Воркер живёт в единственном экземпляре, в отличие от пула классического
 * апскейла: он держит в памяти загруженную модель (880 КБ весов плюс буферы
 * бэкенда), и второй такой же удвоил бы расход, не ускорив ничего —
 * упирается всё в одну видеокарту или в один набор ядер.
 *
 * Загружается лениво: файл ml-worker.js весит около 800 КБ, и платить
 * за него на страницах, где ML не понадобился, незачем.
 */

const log = createLogger('ml')

/** Имена файлов в пакете расширения. Должны быть в web_accessible_resources. */
const WORKER_PATH = 'ml-worker.js'
const WASM_PATH = 'wasm/'

/**
 * Доступные модели.
 *
 * Веса лежат в пакете расширения, а не скачиваются: требование проекта —
 * никаких сетевых запросов в момент работы.
 *
 * ЧЕМ ОНИ РАЗЛИЧАЮТСЯ, КРОМЕ РАЗМЕРА
 *
 * slim и medium — архитектура RDN, вход 0..255, стандартные слои, увеличение
 * вдвое. Различаются глубиной: 2 плотных блока против 10.
 *
 * detailed — архитектура RRDN и совсем другая модель: 477 слоёв против 24,
 * вход 0..1, два вида самописных слоёв, увеличение сразу вчетверо. Главное
 * же отличие не в размере: она обучена как GAN, то есть на правдоподобие,
 * а не на среднеквадратичную ошибку. RDN-модели оптимизированы под PSNR
 * и потому склонны к сглаживанию — отсюда ощущение «мыла». GAN синтезирует
 * текстуру, из-за чего результат выглядит резче, но детали местами
 * придуманы, а не восстановлены.
 */
interface ModelRegistryEntry {
  path: string
  scale: number
  inputMax: number
  customLayers: boolean
  tileSize: number
  tileOverlap: number
  /** Во сколько раз снижается потолок размера входа относительно базового. */
  pixelDivisor: number
}

const MODELS: Record<ModelChoice, ModelRegistryEntry> = {
  slim: {
    path: 'models/esrgan-slim-x2/model.json',
    scale: 2,
    inputMax: 255,
    customLayers: false,
    /**
     * 224 подобрано по замерам: с полями вход не больше 272×272 (74 тысячи
     * пикселей), а падать WebGPU начинал при 691 тысяче. Мельче делать
     * невыгодно — у каждого вызова модели есть постоянные накладные расходы.
     */
    tileSize: 224,
    /** Рецептивное поле: ~10 пикселей у сети из десятка свёрток 3×3. Запас двойной. */
    tileOverlap: 24,
    pixelDivisor: 1,
  },
  medium: {
    path: 'models/esrgan-medium-x2/model.json',
    scale: 2,
    inputMax: 255,
    customLayers: false,
    tileSize: 224,
    tileOverlap: 24,
    /** Замер: вдвое дольше slim на мелкой картинке, разрыв растёт с размером. */
    pixelDivisor: 4,
  },
  detailed: {
    path: 'models/esrgan-gans-x4/model.json',
    scale: 4,
    /** RRDN обучена на диапазоне 0..1, в отличие от RDN-вариантов. */
    inputMax: 1,
    customLayers: true,
    /**
     * Плитка вчетверо меньше по площади, чем у двукратных моделей.
     *
     * Причина не в глубине сети, а в коэффициенте: при увеличении вчетверо
     * выходная плитка со стороной 128 — это уже 512 пикселей, то есть
     * 260 тысяч на выходе. Со стороной 224 вышло бы 800 тысяч, и вычислительная
     * сетка WebGPU снова упёрлась бы в лимит устройства.
     */
    tileSize: 128,
    /**
     * Поля шире: 477 слоёв против 24, и рецептивное поле соответственно
     * больше. Точный расчёт по такой топологии трудоёмок, поэтому взято
     * значение с большим запасом и проверено замером швов.
     */
    tileOverlap: 40,
    pixelDivisor: 8,
  },
}

/**
 * Потолок размера входа, свой для каждого бэкенда.
 *
 * Числа получены замером на реальной модели, а не оценкой:
 *   WebGPU — 1200×900 (1.08 Мп) обрабатывается за 496 мс. Запас до 4 Мп
 *            даёт около двух секунд, что ещё терпимо при видимом прогрессе.
 *   WASM   — 400×300 (120 тыс. пикселей) заняло 1304 мс, то есть около
 *            11 мкс на пиксель. 250 тыс. пикселей — это уже почти три
 *            секунды; выше начинается время, которое пользователь
 *            воспринимает как зависание.
 *
 * Картинки крупнее обрабатываются классическим апскейлом. Это не «хуже»:
 * у большой картинки уже достаточно деталей, и выигрыш от ML там наименьший.
 */
const MAX_INPUT_PIXELS: Record<string, number> = {
  webgpu: 4_000_000,
  wasm: 250_000,
}

const DEFAULT_MAX_INPUT_PIXELS = 150_000

export interface MlRuntime {
  backend: string
  model: ModelChoice
  /** Во сколько раз увеличивает загруженная модель. */
  scale: number
  maxInputPixels: number
  run(bitmap: ImageBitmap, sourceUrl: string, sharpen: number): Promise<EnhanceResult>
  destroy(): void
}

let runtime: Promise<MlRuntime | null> | null = null
/** Модель, под которую поднят текущий рантайм. */
let runtimeModel: ModelChoice | null = null

/**
 * Создание воркера из файла расширения.
 *
 * Ограничение то же, что на этапе 4: конструктор Worker требует тот же
 * источник, а content script для этой проверки относится к источнику
 * страницы. Поэтому код скачивается и оборачивается в blob-URL.
 *
 * Отличие от этапа 4 — здесь код НЕ встроен в бандл, а лежит отдельным
 * файлом и берётся сетевым запросом к самому расширению. Встроить его
 * в content.js нельзя: 800 КБ попадали бы в каждую открытую страницу.
 */
/**
 * Абсолютный URL ресурса расширения.
 *
 * Воркер создан из blob-URL, и его базовый адрес — сам blob. Относительный
 * путь там не разрешается вообще: fetch падает с «Failed to parse URL».
 * Обычный chrome.runtime.getURL и так возвращает абсолютный
 * chrome-extension://-адрес, но полагаться на это не стоит — ошибка вылезла бы
 * глубоко внутри воркера в виде сообщения, по которому причину не угадать.
 *
 * Проверено: с относительным путём модель не грузится, а расширение молча
 * откатывается на классический апскейл.
 */
function absoluteUrl(path: string): string {
  return new URL(chrome.runtime.getURL(path), location.href).href
}

async function spawnWorker(): Promise<Worker> {
  const response = await fetch(chrome.runtime.getURL(WORKER_PATH))
  if (!response.ok) throw new Error(`Не удалось загрузить ${WORKER_PATH}: ${response.status}`)
  const source = await response.text()
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    return new Worker(blobUrl)
  } finally {
    // Воркер уже прочитал код, ссылка больше не нужна: иначе 800 КБ
    // висели бы в памяти до закрытия страницы.
    URL.revokeObjectURL(blobUrl)
  }
}

function waitFor<T extends MlResponse>(
  worker: Worker,
  match: (response: MlResponse) => response is T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as MlResponse
      if (!match(data)) return
      cleanup()
      resolve(data)
    }
    const onError = (event: ErrorEvent): void => {
      cleanup()
      reject(new Error(event.message || 'Воркер завершился с ошибкой'))
    }
    const cleanup = (): void => {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
    }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
  })
}

let nextRequestId = 1

async function createRuntime(model: ModelChoice): Promise<MlRuntime | null> {
  let worker: Worker
  try {
    worker = await spawnWorker()
  } catch (error) {
    /**
     * Сюда попадаем, если политика безопасности страницы запрещает
     * blob-воркеры. Это не ошибка пользователя: классический апскейл
     * продолжает работать, и говорить об этом незачем.
     */
    log.warn('ML-воркер недоступен:', error)
    return null
  }

  const entry = MODELS[model]
  const init: MlInitRequest = {
    type: 'init',
    model: {
      url: absoluteUrl(entry.path),
      scale: entry.scale,
      inputMax: entry.inputMax,
      customLayers: entry.customLayers,
      tileSize: entry.tileSize,
      tileOverlap: entry.tileOverlap,
    },
    wasmBaseUrl: absoluteUrl(WASM_PATH),
    // Решение о бэкенде принимает воркер: он один может достоверно
    // проверить, поднимется ли WebGPU в его собственном контексте.
    preferWebgpu: true,
  }

  const readyPromise = waitFor(
    worker,
    (response): response is Extract<MlResponse, { type: 'ready' | 'init-failed' }> =>
      response.type === 'ready' || response.type === 'init-failed',
  )
  worker.postMessage(init)

  const ready = await readyPromise
  if (ready.type === 'init-failed') {
    log.error('Модель не загрузилась:', ready.error)
    worker.terminate()
    return null
  }

  log.info(`ML готов: модель ${model}, бэкенд ${ready.backend}, загрузка ${ready.loadMs} мс`)

  const basePixels = MAX_INPUT_PIXELS[ready.backend] ?? DEFAULT_MAX_INPUT_PIXELS

  return {
    backend: ready.backend,
    model,
    scale: ready.scale,
    maxInputPixels: Math.round(basePixels / entry.pixelDivisor),
    destroy() {
      worker.terminate()
    },

    async run(bitmap, _sourceUrl, sharpen) {
      const id = nextRequestId
      nextRequestId += 1

      const donePromise = waitFor(
        worker,
        (response): response is Extract<MlResponse, { type: 'done' | 'failed' }> =>
          (response.type === 'done' || response.type === 'failed') && response.id === id,
      )

      const request: MlEnhanceRequest = { type: 'enhance', id, bitmap, sharpen }
      worker.postMessage(request, [bitmap])

      const result = await donePromise
      if (result.type === 'failed') throw new Error(result.error)

      return {
        blob: result.blob,
        width: result.width,
        height: result.height,
        durationMs: result.durationMs,
        backend: result.backend === 'webgpu' ? 'ml-webgpu' : 'ml-wasm',
      }
    },
  }
}

/**
 * Готовый ML-рантайм или null, если ML на этой странице недоступен.
 *
 * При смене модели старый воркер уничтожается вместе с загруженными весами.
 * Держать оба одновременно нельзя: это удвоенная память ради переключения,
 * которое пользователь делает раз в месяц.
 */
export function getMlRuntime(model: ModelChoice): Promise<MlRuntime | null> {
  if (runtime && runtimeModel !== model) {
    log.info(`Модель сменилась на ${model}, перезагружаю воркер`)
    const previous = runtime
    runtime = null
    void previous.then((instance) => instance?.destroy())
  }

  runtimeModel = model
  runtime ??= createRuntime(model).catch((error: unknown) => {
    log.error('Не удалось поднять ML:', error)
    return null
  })
  return runtime
}

/**
 * Подходит ли картинка для ML при данном рантайме.
 *
 * ИСПРАВЛЕНО ПОСЛЕ ЭТАПА 9. Раньше здесь стояло `|scale - 2| < 0.5`, то есть
 * ML включался только при увеличении от 1.5 до 2.5 крат. Логика была вывернута
 * наизнанку: коэффициент считается от нехватки пикселей, и чем сильнее картинку
 * растянули, тем больше он становится — а значит, тем вернее отключалась
 * нейросеть. Ровно в том случае, где она нужнее всего.
 *
 * Симптом: картинка увеличивается, но не становится чётче, потому что
 * втихую работал обычный фильтр.
 *
 * Теперь ML применяется при любом увеличении от полутора крат, а разницу
 * до запрошенного размера дотягивает Ланцош уже поверх результата модели
 * (см. runEnhance). Это лучше, чем Ланцош от оригинала: детали, которых
 * в исходнике не было, к этому моменту уже восстановлены.
 */
export function isMlApplicable(
  mlRuntime: MlRuntime,
  bitmapWidth: number,
  bitmapHeight: number,
  requestedScale: number,
): boolean {
  if (bitmapWidth * bitmapHeight > mlRuntime.maxInputPixels) return false
  /**
   * Ниже полутора крат звать модель незачем: она увеличит сильнее, чем
   * просили, и результат придётся уменьшать — самая дорогая часть пайплайна
   * ради работы, которую тут же частично отменят.
   *
   * Выше — можно всегда, даже если модель увеличивает больше нужного:
   * лишнее уберёт уменьшение, а это ещё и передискретизация с запасом,
   * то есть результат чище, чем при точном попадании.
   */
  return requestedScale >= ML_MIN_SCALE
}
