import type { EnhanceOptions, EnhanceResult } from '@/core/enhance'
import { createLogger } from '@/core/log'
import type { EnhanceWorkerRequest, EnhanceWorkerResponse } from '@/workers/enhance.worker'
import EnhanceWorker from '@/workers/enhance.worker?worker&inline'

/**
 * Пул воркеров, выполняющих улучшение изображений.
 *
 * ПОЧЕМУ ВОРКЕР СОЗДАЁТСЯ ИЗ CONTENT SCRIPT, А НЕ ЧЕРЕЗ OFFSCREEN DOCUMENT
 *
 * Штатная схема расширений MV3 для тяжёлых вычислений — offscreen-документ:
 * невидимая страница расширения, у которой есть DOM и право создавать
 * воркеры. Здесь она не подходит по конкретной причине.
 *
 * Данные между content script и service worker ходят через
 * chrome.runtime.sendMessage, а он сериализует сообщение в JSON. Ни ImageBitmap,
 * ни Blob, ни ArrayBuffer через JSON не проходят — transferable-объекты
 * там невозможны в принципе. Значит, отдать пиксели в offscreen-документ
 * можно было бы только двумя способами:
 *
 *   1. Заново скачать картинку по URL уже в offscreen-документе. Это лишняя
 *      загрузка на каждое действие и — что важнее — ДРУГОЙ набор доступных
 *      картинок: страница расширения запрашивает чужой домен, и без
 *      host_permissions ей ответят не всегда. Картинки, доступные странице
 *      напрямую, перестали бы обрабатываться. Это регресс.
 *   2. Перегнать пиксели в строку (base64). Для картинки 24 Мп это строка
 *      на сотню мегабайт, которую ещё надо сериализовать в JSON. Неприменимо.
 *
 * Поэтому пиксели остаются там, где были получены, — в content script,
 * а вычисления уезжают в воркер, созданный прямо оттуда. ImageBitmap
 * передаётся как transferable, то есть вообще без копирования.
 *
 * ПОЧЕМУ ВОРКЕР ВСТРОЕН В БАНДЛ (?worker&inline)
 *
 * Content script не может создать воркер из файла расширения:
 * `new Worker(chrome.runtime.getURL('...'))` падает, потому что конструктор
 * Worker требует тот же источник, а content script для этой проверки
 * относится к источнику страницы, а не расширения.
 *
 * Суффикс ?worker&inline просит Vite собрать воркер и встроить его код
 * в бандл строкой, из которой воркер создаётся через blob-URL. Blob-URL
 * наследует источник страницы, поэтому ограничение снимается.
 * Побочная выгода: не нужен ни отдельный файл, ни web_accessible_resources,
 * ни сетевой запрос за кодом воркера.
 */

const log = createLogger('worker-pool')

export interface EnhancePool {
  readonly size: number
  run(
    input: { bitmap: ImageBitmap; sourceUrl: string },
    options: EnhanceOptions,
    signal?: AbortSignal,
  ): Promise<EnhanceResult>
  destroy(): void
}

/**
 * Сколько воркеров держать.
 *
 * Половина логических ядер, но не больше четырёх и не меньше одного.
 *
 * Половина, а не все: браузеру нужны потоки на отрисовку, композитинг и сеть,
 * а системе — на всё остальное. Заняв все ядра, мы получим отзывчивость хуже,
 * чем при половине, при том же итоговом времени.
 *
 * Потолок 4 — по памяти, а не по процессору. Каждая задача в работе держит
 * промежуточный буфер (для 1920×1080 → 3840×2160 это 66 МБ) плюс исходный
 * ImageBitmap плюс результат. Четыре одновременно — это уже сотни мегабайт;
 * дальше растёт риск, что вкладку убьёт браузер, а выигрыш во времени
 * упирается в память и кеш процессора.
 */
export function resolveWorkerCount(): number {
  const cores = navigator.hardwareConcurrency || 2
  return Math.max(1, Math.min(4, Math.floor(cores / 2)))
}

interface Slot {
  worker: Worker
  busy: boolean
}

let nextRequestId = 1

/**
 * Создаёт пул. Возвращает null, если воркеры недоступны — тогда вызывающая
 * сторона считает на месте, как на этапах 2-3.
 */
export function createEnhancePool(size = resolveWorkerCount()): EnhancePool | null {
  const slots: Slot[] = []

  const spawn = (): Worker | null => {
    try {
      return new EnhanceWorker()
    } catch (error) {
      /**
       * Реальные причины отказа: политика безопасности страницы,
       * запрещающая blob-воркеры (worker-src), и нехватка ресурсов.
       * И то, и другое — повод честно откатиться на вычисления в потоке
       * страницы, а не показать пользователю ошибку.
       */
      log.warn('Не удалось создать воркер:', error)
      return null
    }
  }

  const first = spawn()
  if (!first) return null
  slots.push({ worker: first, busy: false })

  for (let i = 1; i < size; i++) {
    const worker = spawn()
    if (!worker) break
    slots.push({ worker, busy: false })
  }

  /** Ожидающие свободного воркера. Разбираются в порядке поступления. */
  const waiting: ((slot: Slot) => void)[] = []

  const acquire = (): Promise<Slot> => {
    const free = slots.find((slot) => !slot.busy)
    if (free) {
      free.busy = true
      return Promise.resolve(free)
    }
    return new Promise((resolve) => waiting.push(resolve))
  }

  const release = (slot: Slot): void => {
    const next = waiting.shift()
    if (next) {
      // Воркер сразу уходит следующему в очереди, busy не сбрасываем.
      next(slot)
      return
    }
    slot.busy = false
  }

  /**
   * Замена воркера — единственный способ прервать работу.
   *
   * Фильтр Ланцоша внутри воркера синхронный: он не проверяет никаких флагов
   * и не отдаёт управление, пока не досчитает. Сообщение «отменись» просто
   * не будет прочитано до конца работы. terminate() убивает поток немедленно,
   * вместе со всей занятой им памятью.
   */
  const recycle = (slot: Slot): void => {
    slot.worker.terminate()
    const replacement = spawn()
    if (replacement) {
      slot.worker = replacement
      release(slot)
      return
    }
    // Создать замену не вышло — убираем слот из пула, чтобы в него
    // не пытались отправлять задачи.
    const index = slots.indexOf(slot)
    if (index >= 0) slots.splice(index, 1)
    log.error('Воркер потерян и не восстановлен, размер пула:', slots.length)
  }

  return {
    get size() {
      return slots.length
    },

    async run(input, options, signal) {
      if (signal?.aborted) throw new DOMException('Обработка отменена', 'AbortError')

      const slot = await acquire()

      return new Promise<EnhanceResult>((resolve, reject) => {
        const id = nextRequestId
        nextRequestId += 1

        const detach = (): void => {
          slot.worker.removeEventListener('message', onMessage)
          slot.worker.removeEventListener('error', onError)
          signal?.removeEventListener('abort', onAbort)
        }

        function onMessage(event: MessageEvent): void {
          const data = event.data as EnhanceWorkerResponse
          // Воркер переиспользуется, и на нём могут остаться хвосты
          // предыдущих задач — сверяем идентификатор.
          if (data.id !== id) return
          detach()
          release(slot)
          if (data.ok) {
            resolve({
              blob: data.blob,
              width: data.width,
              height: data.height,
              durationMs: data.durationMs,
              backend: data.backend,
            })
          } else {
            reject(new Error(data.error))
          }
        }

        function onError(event: ErrorEvent): void {
          detach()
          // Упавший воркер нельзя переиспользовать: его состояние неизвестно.
          recycle(slot)
          reject(new Error(event.message || 'Воркер завершился с ошибкой'))
        }

        function onAbort(): void {
          detach()
          recycle(slot)
          reject(new DOMException('Обработка отменена', 'AbortError'))
        }

        slot.worker.addEventListener('message', onMessage)
        slot.worker.addEventListener('error', onError)
        signal?.addEventListener('abort', onAbort, { once: true })

        const request: EnhanceWorkerRequest = {
          id,
          bitmap: input.bitmap,
          sourceUrl: input.sourceUrl,
          options,
        }
        /**
         * Второй аргумент — список transferable-объектов. Это не оптимизация
         * «на всякий случай»: без него ImageBitmap был бы СКОПИРОВАН,
         * то есть для картинки 4000×3000 браузер выделил бы и заполнил
         * ещё 48 МБ. С передачей владения копирования не происходит вовсе,
         * а исходный объект в этом потоке становится недоступен.
         */
        slot.worker.postMessage(request, [input.bitmap])
      })
    },

    destroy() {
      for (const slot of slots) slot.worker.terminate()
      slots.length = 0
      waiting.length = 0
    },
  }
}
