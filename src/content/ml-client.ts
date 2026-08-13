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
  /** Формат сохранения — от него зависит функция загрузки. См. MlModelSpec. */
  format: 'layers' | 'graph'
  scale: number
  inputMax: number
  customLayers: boolean
  tileSize: number
  tileOverlap: number
  /** Требует ли модель плитку строго размера tileSize + 2 × tileOverlap. */
  fixedInputSize: boolean
  /**
   * Стоимость одного прохода модели: микросекунды на пиксель ВХОДА, WebGPU.
   *
   * Из этого числа и бюджета времени выводится потолок размера картинки —
   * см. MAX_INPUT_PIXELS ниже. Раньше вместо замера стоял делитель «на глаз»,
   * и он оказался вчетверо строже, чем нужно: детальная модель отключалась
   * на картинках крупнее 866×577, то есть почти на всех настоящих.
   *
   * Замер на этой машине (WebGPU, ровно один проход в родном коэффициенте,
   * без остатка на Ланцош, после прогрева):
   *
   *   модель      600×440   1200×880
   *   slim  (×2)    0.9        0.6
   *   medium(×2)    1.2        0.4
   *   detailed(×4)  5.3        5.1
   *
   * Разброс у лёгких моделей — это постоянные накладные расходы вызова,
   * заметные на мелкой картинке и растворяющиеся на крупной. У детальной
   * стоимость ровная: она считает достаточно долго, чтобы накладные расходы
   * не были видны.
   *
   * Кстати, отсюда следует поправка к этапу 10: medium НЕ вдвое медленнее
   * slim. То измерение сделали на картинке 240×180, где почти всё время
   * занимали накладные расходы, а не свёртки.
   */
  usPerPixel: number
  /**
   * Синтезирует ли модель новые детали.
   *
   * Различие решает, годится ли модель для улучшения качества БЕЗ изменения
   * размера. Там картинка прогоняется через модель с увеличением и возвращается
   * к исходному размеру уменьшением, и выигрыш возможен, только если модель
   * добавила то, чего не было.
   *
   * Замер на фотоподобной картинке 300×220, сжатой в JPEG с качеством 0.6
   * (резкость — модуль лапласиана, средний и 99-й перцентиль):
   *
   *   вариант                       среднее   p99     время
   *   оригинал                      12.79     56.00   —
   *   только маскирование           15.07     71.75    68 мс
   *   круговой рейс с RDN (slim)    10.83     46.63   650 мс  ← ХУЖЕ оригинала
   *   круговой рейс с GAN           17.26     80.71   952 мс
   *
   * RDN обучены минимизировать ошибку и потому сглаживают; при уменьшении
   * обратно теряется больше, чем было добавлено. GAN синтезирует текстуру,
   * и она переживает уменьшение.
   */
  synthesizesDetail: boolean
}

const MODELS: Record<ModelChoice, ModelRegistryEntry> = {
  slim: {
    path: 'models/esrgan-slim-x2/model.json',
    format: 'layers',
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
    usPerPixel: 0.9,
    fixedInputSize: false,
    synthesizesDetail: false,
  },
  medium: {
    path: 'models/esrgan-medium-x2/model.json',
    format: 'layers',
    scale: 2,
    inputMax: 255,
    customLayers: false,
    tileSize: 224,
    tileOverlap: 24,
    usPerPixel: 1.2,
    fixedInputSize: false,
    synthesizesDetail: false,
  },
  detailed: {
    path: 'models/esrgan-gans-x4/model.json',
    format: 'layers',
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
    usPerPixel: 5.3,
    fixedInputSize: false,
    /** Обучена как GAN: синтезирует текстуру, а не сглаживает. */
    synthesizesDetail: true,
  },
  real: {
    path: 'models/realesrgan-general-x4/model.json',
    /** Экспортирована как граф операций, а не как набор слоёв. */
    format: 'graph',
    scale: 4,
    inputMax: 1,
    /** У graph-модели слоёв нет вообще — регистрировать нечего. */
    customLayers: false,
    /**
     * 48 и 8 выбраны не по рецептивному полю, а по арифметике: модель
     * экспортирована с жёстко зафиксированным входом 64×64, и сумма
     * 48 + 2 × 8 обязана дать ровно 64. Свободы здесь ровно одна —
     * как поделить 64 между сердцевиной и полями.
     *
     * Поля в 8 пикселей проверены замером швов на гладком градиенте:
     * границы плиток не обнаруживаются. Шире поля — меньше полезной
     * площади: при 48 из 64 на дело идёт 56% каждого прогона, при 40 из 64
     * было бы уже 39%, то есть почти в полтора раза больше работы.
     */
    tileSize: 48,
    tileOverlap: 8,
    /** Замер: 5.5 мс на плитку 64×64, то есть 1.3 мкс на пиксель входа. */
    usPerPixel: 1.3,
    fixedInputSize: true,
    synthesizesDetail: true,
  },
}

/**
 * Сколько времени не жалко на одну картинку.
 *
 * Потолок размера считается ИЗ ЭТОГО и стоимости модели, а не задаётся
 * числом пикселей напрямую. Так он остаётся осмысленным при добавлении
 * новой модели: у неё своя стоимость, и потолок выведется сам.
 *
 * Прежняя схема — общий потолок в пикселях плюс делитель «на глаз» для тяжёлых
 * моделей — давала детальной модели 500 тысяч пикселей, то есть 866×577.
 * Настоящих картинок такого размера в интернете почти нет, и модель, которую
 * пользователь выбрал осознанно, молча не запускалась.
 *
 * Цифры бюджета:
 *   WebGPU — 8 секунд. Много, но это осознанный выбор пользователя,
 *            и всё это время видно уведомление с кнопкой отмены.
 *   WASM   — 2.5 секунды. Здесь запаса нет: считает процессор, страница
 *            остаётся отзывчивой только благодаря воркеру, а само ожидание
 *            без видимой причины воспринимается как зависание.
 */
const TIME_BUDGET_MS: Record<string, number> = {
  webgpu: 8_000,
  wasm: 2_500,
}

const DEFAULT_TIME_BUDGET_MS = 1_500

/**
 * Во сколько раз WASM медленнее WebGPU.
 *
 * Замерено на этапе 5 для лёгкой модели: 11 мкс/пиксель против 0.9 —
 * порядок величины. Отдельные замеры для каждой модели на WASM снимать
 * не стали: детальная там всё равно неприменима по времени, а точность
 * этого коэффициента влияет только на границу, за которой мы и так
 * отказываемся считать.
 */
const WASM_SLOWDOWN = 12

/**
 * Абсолютный потолок независимо от бюджета времени.
 *
 * Ограничение уже не по времени, а по памяти: при увеличении вчетверо
 * 4 мегапикселя входа — это 64 мегапикселя выхода, то есть четверть
 * гигабайта на один холст. Быстрая машина уложилась бы в бюджет времени
 * и по нему прошла бы дальше.
 */
const HARD_MAX_INPUT_PIXELS = 4_000_000

export interface MlRuntime {
  backend: string
  model: ModelChoice
  /** Во сколько раз увеличивает загруженная модель. */
  scale: number
  maxInputPixels: number
  run(bitmap: ImageBitmap, sourceUrl: string, sharpen: number): Promise<EnhanceResult>
  destroy(): void
}

/**
 * Свойство модели, известное ДО её загрузки.
 *
 * Нужно именно так: улучшение качества без изменения размера отказывается
 * от модели, которая сглаживает, и без этой функции пришлось бы сначала
 * поднять воркер (800 КБ кода плюс веса), спросить у него свойство и тут же
 * всё выбросить. Замер разницы: 464 мс против 84 мс на одной и той же
 * картинке — почти всё это время уходило на загрузку впустую.
 */
export function modelSynthesizesDetail(model: ModelChoice): boolean {
  return MODELS[model].synthesizesDetail
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
      format: entry.format,
      scale: entry.scale,
      inputMax: entry.inputMax,
      customLayers: entry.customLayers,
      tileSize: entry.tileSize,
      tileOverlap: entry.tileOverlap,
      fixedInputSize: entry.fixedInputSize,
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

  const budgetMs = TIME_BUDGET_MS[ready.backend] ?? DEFAULT_TIME_BUDGET_MS
  const usPerPixel = entry.usPerPixel * (ready.backend === 'webgpu' ? 1 : WASM_SLOWDOWN)
  const maxInputPixels = Math.min(
    HARD_MAX_INPUT_PIXELS,
    Math.round((budgetMs * 1000) / usPerPixel),
  )

  log.info(
    `Потолок размера: ${maxInputPixels} пикселей ` +
      `(бюджет ${budgetMs} мс при ${usPerPixel.toFixed(1)} мкс/пиксель)`,
  )

  return {
    backend: ready.backend,
    model,
    scale: ready.scale,
    maxInputPixels,
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
