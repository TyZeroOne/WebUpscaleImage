import { createEnhancer } from '@/core/enhance'
import type { EnhanceBackend, EnhanceOptions } from '@/core/enhance'

/**
 * Воркер, выполняющий улучшение изображения вне главного потока страницы.
 *
 * Здесь нет ни DOM, ни chrome API — только вычисления. Это не ограничение,
 * а вся суть: воркер не может подвесить страницу, потому что живёт
 * в отдельном потоке.
 *
 * Модуль core/enhance/ переехал сюда без единой правки. Так вышло потому,
 * что с этапа 2 он писался на OffscreenCanvas (доступен в воркере)
 * вместо HTMLCanvasElement (недоступен) и не обращался ни к DOM,
 * ни к chrome.*.
 */

export interface EnhanceWorkerRequest {
  id: number
  /** Передаётся как transferable: копирования пикселей не происходит. */
  bitmap: ImageBitmap
  sourceUrl: string
  options: EnhanceOptions
}

export type EnhanceWorkerResponse =
  | {
      id: number
      ok: true
      blob: Blob
      width: number
      height: number
      durationMs: number
      backend: EnhanceBackend
    }
  | { id: number; ok: false; error: string }

/**
 * Минимальное описание области видимости воркера.
 *
 * Полные типы живут в библиотеке "WebWorker", а она конфликтует с "DOM"
 * в пределах одного tsconfig (десятки одинаковых имён с разными сигнатурами).
 * Заводить второй tsconfig и вторую команду проверки типов ради одного файла
 * дороже, чем описать здесь три нужных метода.
 *
 * Если воркер вырастет (этап 5, ML-инференс), отдельный tsconfig.worker.json
 * станет оправдан.
 */
interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

const scope = self as unknown as WorkerScope

scope.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as EnhanceWorkerRequest

  void (async () => {
    try {
      const enhancer = createEnhancer(request.options.level)
      const result = await enhancer.enhance(
        { bitmap: request.bitmap, sourceUrl: request.sourceUrl },
        request.options,
      )
      const response: EnhanceWorkerResponse = {
        id: request.id,
        ok: true,
        blob: result.blob,
        width: result.width,
        height: result.height,
        durationMs: result.durationMs,
        backend: result.backend,
      }
      scope.postMessage(response)
    } catch (error) {
      /**
       * Объект Error не переживает structured clone целиком: тип и стек
       * теряются, остаётся сообщение. Поэтому наружу отдаётся строка,
       * а разбирать её на понятную пользователю формулировку будет
       * вызывающая сторона.
       */
      const response: EnhanceWorkerResponse = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
      scope.postMessage(response)
    } finally {
      /**
       * Владение картинкой перешло сюда вместе с transfer: в содержащем
       * потоке она уже недоступна, и освободить её может только воркер.
       */
      request.bitmap.close()
    }
  })()
})
