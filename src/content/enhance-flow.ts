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

/**
 * Полный путь обработки одной картинки: пиксели -> апскейл -> результат.
 *
 * ГДЕ ЭТО ВЫПОЛНЯЕТСЯ И ПОЧЕМУ ЭТО ВРЕМЕННО
 *
 * На этапе 2 вычисления идут прямо здесь — в главном потоке страницы,
 * и это будет исправлено на этапе 4. Замеренная стоимость фильтра
 * (Ланцош, радиус 2 / радиус 3):
 *
 *     640×480   -> 1280×960     46 / 53 мс
 *     960×540   -> 1920×1080    66 / 85 мс
 *     1920×1080 -> 3840×2160   253 / 325 мс
 *     3000×2000 -> 4472×2981   443 / 578 мс
 *
 * Плюс кодирование результата в PNG, которое на больших размерах стоит
 * не меньше самого фильтра. То есть на крупной картинке страница замирает
 * почти на секунду — терпимо для одного изображения и совершенно
 * неприемлемо для очереди из этапа 3.
 *
 * Сделано так намеренно. Сначала нужно получить работающий сквозной путь
 * на понятном коде, увидеть реальные цифры и только потом переносить
 * готовую и проверенную логику в Worker. Обратный порядок — писать сразу
 * в Worker — означал бы отлаживать одновременно и алгоритм, и обмен
 * сообщениями между потоками.
 *
 * Модуль core/enhance/ к этому переносу уже готов: он не обращается ни к DOM,
 * ни к chrome API и работает только с OffscreenCanvas, который есть и в Worker.
 */

const log = createLogger('enhance')

export interface EnhanceFlowDeps {
  toaster: Toaster
}

/**
 * Пауза, дающая браузеру отрисовать кадр до начала тяжёлых вычислений.
 *
 * Без неё тост «Обрабатываю…» не успевает появиться: мы меняем DOM и тут же
 * занимаем поток на секунду, а браузер рисует только между задачами.
 * Пользователь видит зависшую страницу без единого объяснения.
 *
 * requestAnimationFrame срабатывает ПЕРЕД отрисовкой, поэтому одного его мало.
 * Пара «rAF, затем setTimeout» гарантирует, что мы вернём управление уже
 * после того, как кадр показан.
 *
 * СТРАХОВКА ОБЯЗАТЕЛЬНА. В невидимой вкладке браузер не рисует кадры,
 * и requestAnimationFrame не вызывается вовсе — ожидание внутри него
 * не закончилось бы никогда. Без второго таймера пользователь, переключивший
 * вкладку сразу после клика, получил бы вечное «Обрабатываю…».
 * Проверено на стенде: без страховки обработка не завершалась.
 *
 * Сам приём — костыль до этапа 4: в Worker'е поток страницы не занят,
 * и отдавать ему кадр незачем.
 */
const PAINT_FALLBACK_MS = 50

function yieldUntilPainted(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    requestAnimationFrame(() => setTimeout(finish, 0))
    setTimeout(finish, PAINT_FALLBACK_MS)
  })
}

function describeFailure(error: unknown): string {
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

export function createEnhanceFlow({ toaster }: EnhanceFlowDeps) {
  /** Картинки, которые обрабатываются прямо сейчас, — защита от двойного клика. */
  const inFlight = new WeakSet<HTMLImageElement>()

  return async function enhanceImage(
    image: HTMLImageElement,
    trigger: EnhanceTrigger,
  ): Promise<void> {
    if (inFlight.has(image)) {
      toaster.show('Эта картинка уже обрабатывается.')
      return
    }
    inFlight.add(image)

    const sourceUrl = image.currentSrc || image.src
    const displayWidth = image.getBoundingClientRect().width
    const scale = resolveScale(displayWidth, image.naturalWidth, window.devicePixelRatio)

    // Отчёт в service worker. На этапе 2 он только пишет в лог: сама работа
    // идёт здесь. На этапе 4 это сообщение станет настоящей передачей задачи.
    void sendToBackground('ENHANCE_IMAGE', {
      sourceUrl,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      trigger,
    })

    const target = resolveTargetSize(image.naturalWidth, image.naturalHeight, scale)
    const progress = toaster.show(
      `Обрабатываю: ${image.naturalWidth}×${image.naturalHeight} → ${target.width}×${target.height}…`,
      { tone: 'progress', durationMs: null },
    )

    let bitmap: ImageBitmap | undefined
    try {
      bitmap = await acquireReadableBitmap(image)
      await yieldUntilPainted()

      const enhancer = createEnhancer(DEFAULT_QUALITY_LEVEL)
      const result = await enhancer.enhance({ bitmap, sourceUrl }, { level: DEFAULT_QUALITY_LEVEL, scale })

      log.info(
        `Готово за ${result.durationMs} мс (${result.backend}): ` +
          `${bitmap.width}×${bitmap.height} → ${result.width}×${result.height}, ` +
          `${Math.round(result.blob.size / 1024)} КБ`,
      )

      replaceOnPage(image, result.blob)

      const sizeMb = result.blob.size / 1024 / 1024
      progress.update(
        `Готово: ${result.width}×${result.height}, ${sizeMb.toFixed(1)} МБ, ${result.durationMs} мс.`,
        {
          tone: 'info',
          // Дольше обычного: у тоста есть кнопки, и их надо успеть нажать.
          durationMs: 12_000,
          actions: [
            {
              label: 'Скачать',
              onClick: () =>
                downloadBlob(result.blob, buildFileName(sourceUrl, result.width, result.height)),
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
}
