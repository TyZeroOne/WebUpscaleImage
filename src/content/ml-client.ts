import type { EnhanceResult } from '@/core/enhance'
import { createLogger } from '@/core/log'
import {
  ML_SCALE,
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
const MODEL_PATH = 'models/esrgan-slim-x2/model.json'
const WASM_PATH = 'wasm/'

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
  maxInputPixels: number
  run(bitmap: ImageBitmap, sourceUrl: string): Promise<EnhanceResult>
}

let runtime: Promise<MlRuntime | null> | null = null

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

async function createRuntime(): Promise<MlRuntime | null> {
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

  const init: MlInitRequest = {
    type: 'init',
    modelUrl: chrome.runtime.getURL(MODEL_PATH),
    wasmBaseUrl: chrome.runtime.getURL(WASM_PATH),
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

  log.info(`ML готов: бэкенд ${ready.backend}, загрузка ${ready.loadMs} мс`)

  return {
    backend: ready.backend,
    maxInputPixels: MAX_INPUT_PIXELS[ready.backend] ?? DEFAULT_MAX_INPUT_PIXELS,

    async run(bitmap, _sourceUrl) {
      const id = nextRequestId
      nextRequestId += 1

      const donePromise = waitFor(
        worker,
        (response): response is Extract<MlResponse, { type: 'done' | 'failed' }> =>
          (response.type === 'done' || response.type === 'failed') && response.id === id,
      )

      const request: MlEnhanceRequest = { type: 'enhance', id, bitmap }
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

/** Готовый ML-рантайм или null, если ML на этой странице недоступен. */
export function getMlRuntime(): Promise<MlRuntime | null> {
  runtime ??= createRuntime().catch((error: unknown) => {
    log.error('Не удалось поднять ML:', error)
    return null
  })
  return runtime
}

/** Подходит ли картинка для ML при данном рантайме. */
export function isMlApplicable(
  mlRuntime: MlRuntime,
  bitmapWidth: number,
  bitmapHeight: number,
  requestedScale: number,
): boolean {
  if (bitmapWidth * bitmapHeight > mlRuntime.maxInputPixels) return false
  /**
   * Модель увеличивает ровно вдвое — это её архитектура, а не параметр.
   * Если запрошено заметно больше, ML дал бы не тот размер, и результат
   * пришлось бы ещё растягивать классикой, теряя всю выгоду.
   */
  return Math.abs(requestedScale - ML_SCALE) < 0.5
}
