import {
  DEFAULT_QUALITY_LEVEL,
  createEnhancer,
  resolveScale,
  resolveTargetSize,
} from '@/core/enhance'
import { createLogger } from '@/core/log'
import { sendToBackground } from '@/core/messaging'
import type { EnhanceTrigger } from '@/core/messaging'
import type { Toaster } from '@/ui/toast'
import { buildFileName, downloadBlob, replaceOnPage, restoreOriginal } from './apply-result'
import { ImageSourceError, acquireReadableBitmap } from './image-source'
import { yieldUntilPainted } from './scheduler'

/**
 * Обработка одной картинки: пиксели -> апскейл -> подмена на странице.
 *
 * Модуль разделён на две части:
 *   enhanceImageCore  — сама работа, без UI. Её вызывает и кнопка, и очередь
 *                       режима «вся страница» (этап 3).
 *   createEnhanceFlow — обёртка с тостами для сценария «одна картинка».
 *
 * Разделение появилось на этапе 3: в пакетном режиме тост на каждую картинку
 * был бы стеной уведомлений, там показывается общая панель прогресса.
 * Сама же работа обязана быть одна и та же — иначе два режима начнут
 * расходиться в поведении.
 *
 * ГДЕ ЭТО ВЫПОЛНЯЕТСЯ И ПОЧЕМУ ЭТО ВРЕМЕННО
 *
 * На этапе 2-3 вычисления идут прямо здесь — в главном потоке страницы,
 * и это будет исправлено на этапе 4. Замеренная стоимость фильтра
 * (Ланцош, радиус 2 / радиус 3):
 *
 *     640×480   -> 1280×960     46 / 53 мс
 *     960×540   -> 1920×1080    66 / 85 мс
 *     1920×1080 -> 3840×2160   253 / 325 мс
 *     3000×2000 -> 4472×2981   443 / 578 мс
 *
 * Плюс кодирование результата в PNG. То есть на крупной картинке страница
 * замирает почти на секунду — терпимо для одного изображения и очень
 * заметно для очереди из этапа 3.
 *
 * Модуль core/enhance/ к переносу готов: он не обращается ни к DOM,
 * ни к chrome API и работает только с OffscreenCanvas, который есть и в Worker.
 */

const log = createLogger('enhance')

export interface EnhanceOutcome {
  width: number
  height: number
  durationMs: number
  blob: Blob
  sourceUrl: string
}

/** Картинки, которые обрабатываются прямо сейчас, — защита от двойного запуска. */
const inFlight = new WeakSet<HTMLImageElement>()

export class AlreadyRunningError extends Error {
  constructor() {
    super('Эта картинка уже обрабатывается')
    this.name = 'AlreadyRunningError'
  }
}

export function describeFailure(error: unknown): string {
  if (error instanceof AlreadyRunningError) return 'Эта картинка уже обрабатывается.'
  if (error instanceof ImageSourceError) {
    switch (error.reason) {
      case 'not-loaded':
        return 'Картинка ещё не загрузилась. Попробуйте ещё раз.'
      case 'tainted':
        return 'Сайт не разрешает читать эту картинку. Обход появится на этапе 7.'
      case 'decode-failed':
        return 'Не удалось прочитать эту картинку.'
    }
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'Обработка отменена.'
  }
  if (error instanceof RangeError) {
    // Типичный случай: не хватило памяти на буферы для очень большой картинки.
    return 'Картинка слишком большая для обработки.'
  }
  return 'Не удалось обработать картинку.'
}

/** Целевой размер — нужен ещё до начала работы, чтобы показать его в UI. */
export function planEnhance(image: HTMLImageElement): {
  scale: number
  width: number
  height: number
} {
  const displayWidth = image.getBoundingClientRect().width
  const scale = resolveScale(displayWidth, image.naturalWidth, window.devicePixelRatio)
  const target = resolveTargetSize(image.naturalWidth, image.naturalHeight, scale)
  return { scale, width: target.width, height: target.height }
}

/**
 * Обработка без какого-либо UI. Бросает исключение при неудаче —
 * вызывающая сторона решает, как о ней сообщить.
 */
export async function enhanceImageCore(
  image: HTMLImageElement,
  trigger: EnhanceTrigger,
  signal?: AbortSignal,
): Promise<EnhanceOutcome> {
  if (inFlight.has(image)) throw new AlreadyRunningError()
  inFlight.add(image)

  const sourceUrl = image.currentSrc || image.src
  const { scale } = planEnhance(image)

  // Отчёт в service worker. На этапе 2-3 он только пишет в лог: сама работа
  // идёт здесь. На этапе 4 это сообщение станет передачей задачи.
  void sendToBackground('ENHANCE_IMAGE', {
    sourceUrl,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    trigger,
  })

  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await acquireReadableBitmap(image)
    await yieldUntilPainted()

    const enhancer = createEnhancer(DEFAULT_QUALITY_LEVEL)
    const result = await enhancer.enhance(
      { bitmap, sourceUrl },
      { level: DEFAULT_QUALITY_LEVEL, scale },
      signal,
    )

    log.info(
      `Готово за ${result.durationMs} мс (${result.backend}): ` +
        `${bitmap.width}×${bitmap.height} → ${result.width}×${result.height}, ` +
        `${Math.round(result.blob.size / 1024)} КБ`,
    )

    replaceOnPage(image, result.blob)

    return {
      width: result.width,
      height: result.height,
      durationMs: result.durationMs,
      blob: result.blob,
      sourceUrl,
    }
  } finally {
    /**
     * ImageBitmap держит несжатые пиксели вне кучи JavaScript, и сборщик
     * мусора освобождает их не сразу. Для картинки 4000×3000 это 48 МБ,
     * которые иначе провисят до следующей сборки. close() освобождает их
     * немедленно.
     */
    bitmap?.close()
    inFlight.delete(image)
  }
}

export interface EnhanceFlowDeps {
  toaster: Toaster
}

/** Сценарий «одна картинка»: та же работа плюс тосты с ходом и результатом. */
export function createEnhanceFlow({ toaster }: EnhanceFlowDeps) {
  return async function enhanceImage(
    image: HTMLImageElement,
    trigger: EnhanceTrigger,
  ): Promise<void> {
    const plan = planEnhance(image)
    const progress = toaster.show(
      `Обрабатываю: ${image.naturalWidth}×${image.naturalHeight} → ${plan.width}×${plan.height}…`,
      { tone: 'progress', durationMs: null },
    )

    try {
      const outcome = await enhanceImageCore(image, trigger)
      const sizeMb = outcome.blob.size / 1024 / 1024

      progress.update(
        `Готово: ${outcome.width}×${outcome.height}, ${sizeMb.toFixed(1)} МБ, ${outcome.durationMs} мс.`,
        {
          tone: 'info',
          // Дольше обычного: у тоста есть кнопки, и их надо успеть нажать.
          durationMs: 12_000,
          actions: [
            {
              label: 'Скачать',
              onClick: () =>
                downloadBlob(
                  outcome.blob,
                  buildFileName(outcome.sourceUrl, outcome.width, outcome.height),
                ),
            },
            {
              label: 'Вернуть',
              onClick: () => {
                restoreOriginal(image)
                progress.dismiss()
              },
            },
          ],
        },
      )
    } catch (error) {
      log.error('Обработка не удалась:', error)
      progress.update(describeFailure(error), { tone: 'error' })
    }
  }
}
