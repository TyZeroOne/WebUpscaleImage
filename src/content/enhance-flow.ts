import { resolvePlan, resolveScale, resolveTargetSize } from '@/core/enhance'
import type { QualityLevel } from '@/core/enhance'
import { getSettings } from '@/core/settings'
import { t } from '@/core/i18n'
import { createLogger } from '@/core/log'
import { sendToBackground } from '@/core/messaging'
import type { EnhanceTrigger } from '@/core/messaging'
import type { Toaster } from '@/ui/toast'
import { buildFileName, downloadBlob, replaceOnPage, restoreOriginal } from './apply-result'
import { isWorkerModeActive, runEnhance } from './enhance-runner'
import { ImageSourceError, acquireReadableBitmap } from './image-source'
import { resolveQualityLevel } from './quality'
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
 * ГДЕ ЭТО ВЫПОЛНЯЕТСЯ
 *
 * С этапа 4 вычисления идут в пуле воркеров (см. enhance-runner.ts):
 * главный поток страницы занят только получением пикселей и подменой
 * картинки, то есть долями миллисекунды.
 *
 * Стоимость самого фильтра не изменилась — она просто перестала быть
 * временем, на которое замирает страница (Ланцош, радиус 2 / радиус 3):
 *
 *     640×480   -> 1280×960     46 / 53 мс
 *     960×540   -> 1920×1080    66 / 85 мс
 *     1920×1080 -> 3840×2160   253 / 325 мс
 *     3000×2000 -> 4472×2981   443 / 578 мс
 *
 * Если воркеры недоступны (политика безопасности страницы запрещает
 * blob-воркеры), расширение считает на месте, как на этапах 2-3, —
 * медленнее для страницы, но работает.
 */

const log = createLogger('enhance')

export interface EnhanceOutcome {
  width: number
  height: number
  durationMs: number
  blob: Blob
  sourceUrl: string
  /** Заменена ли картинка на странице. Зависит от настройки replaceOnPage. */
  replaced: boolean
}

/** Картинки, которые обрабатываются прямо сейчас, — защита от двойного запуска. */
const inFlight = new WeakSet<HTMLImageElement>()

export class AlreadyRunningError extends Error {
  constructor() {
    super('Эта картинка уже обрабатывается')
    this.name = 'AlreadyRunningError'
  }
}

/**
 * Причина неудачи человеческим языком.
 *
 * Правило для всех формулировок: сообщение должно отвечать на вопрос
 * «что теперь делать», а не «что сломалось». «SecurityError» и
 * «Не удалось обработать» одинаково бесполезны — из них не следует
 * ни одного действия.
 *
 * Где действие невозможно в принципе (векторная картинка), сообщение
 * объясняет, почему обработка не нужна, а не притворяется ошибкой.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof AlreadyRunningError) return t('errAlreadyRunning')
  if (error instanceof ImageSourceError) {
    switch (error.reason) {
      case 'not-loaded':
        return t('errNotLoaded')
      case 'tainted':
        return t('errTainted')
      case 'decode-failed':
        return t('errDecode')
      case 'unsupported-format':
        return t('errVector')
      case 'too-large':
        return t('errTooLarge')
    }
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return t('errAborted')
  }
  if (error instanceof RangeError) {
    // Типичный случай: не хватило памяти на буферы для очень большой картинки.
    return t('errOutOfMemory')
  }
  return t('errGeneric')
}

/** Целевой размер — нужен ещё до начала работы, чтобы показать его в UI. */
export function planEnhance(
  image: HTMLImageElement,
  level: QualityLevel,
): { scale: number; width: number; height: number } {
  const displayWidth = image.getBoundingClientRect().width
  const scale = resolveScale(
    displayWidth,
    image.naturalWidth,
    window.devicePixelRatio,
    resolvePlan(level).maxScale,
  )
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
  const level = await resolveQualityLevel()
  const { scale } = planEnhance(image, level)

  // Отчёт в service worker. На этапе 2-3 он только пишет в лог: сама работа
  // идёт здесь. На этапе 4 это сообщение станет передачей задачи.
  void sendToBackground('ENHANCE_IMAGE', {
    sourceUrl,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    trigger,
  })

  let bitmap: ImageBitmap | undefined
  let handedOff = false
  try {
    bitmap = await acquireReadableBitmap(image)
    /**
     * Размеры запоминаются ДО передачи в воркер. После transfer объект
     * в этом потоке отсоединён, и bitmap.width вернёт 0 — в логе оказались бы
     * бессмысленные «0×0 → 3840×2160».
     */
    const sourceSize = `${bitmap.width}×${bitmap.height}`

    await yieldUntilPainted()

    // С этого момента картинкой владеет runEnhance: она либо уедет в воркер
    // вместе с владением, либо будет освобождена там же после вычислений.
    handedOff = true
    const result = await runEnhance({ bitmap, sourceUrl }, { level, scale }, signal)

    log.info(
      `Готово за ${result.durationMs} мс (${result.backend}, ` +
        `${isWorkerModeActive() ? 'воркер' : 'поток страницы'}): ` +
        `${sourceSize} → ${result.width}×${result.height}, ` +
        `${Math.round(result.blob.size / 1024)} КБ`,
    )

    /**
     * Подмена на странице — настройка, а не данность. Часть пользователей
     * хочет получить файл, не трогая вид сайта: подменённая картинка может
     * сломать вёрстку, если сайт рассчитывает на конкретные размеры.
     */
    const settings = await getSettings()
    if (settings.replaceOnPage) replaceOnPage(image, result.blob)

    return {
      width: result.width,
      height: result.height,
      durationMs: result.durationMs,
      blob: result.blob,
      sourceUrl,
      replaced: settings.replaceOnPage,
    }
  } finally {
    /**
     * Освобождаем только если картинка так и не была передана дальше:
     * ImageBitmap держит несжатые пиксели вне кучи JavaScript (48 МБ
     * для 4000×3000), и сборщик мусора не спешит их забирать.
     */
    if (!handedOff) bitmap?.close()
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
    const level = await resolveQualityLevel()
    const plan = planEnhance(image, level)
    const progress = toaster.show(
      t(
        'toastProcessing',
        `${image.naturalWidth}×${image.naturalHeight}`,
        `${plan.width}×${plan.height}`,
      ),
      { tone: 'progress', durationMs: null },
    )

    try {
      const outcome = await enhanceImageCore(image, trigger)
      const sizeMb = outcome.blob.size / 1024 / 1024

      progress.update(
        t(
          'toastDone',
          `${outcome.width}×${outcome.height}`,
          sizeMb.toFixed(1),
          String(outcome.durationMs),
        ),
        {
          tone: 'info',
          // Дольше обычного: у тоста есть кнопки, и их надо успеть нажать.
          durationMs: 12_000,
          actions: [
            {
              label: t('actionDownload'),
              onClick: () =>
                downloadBlob(
                  outcome.blob,
                  buildFileName(outcome.sourceUrl, outcome.width, outcome.height),
                ),
            },
            // Возвращать нечего, если подмена на странице выключена настройкой.
            ...(outcome.replaced
              ? [
                  {
                    label: t('actionRestore'),
                    onClick: () => {
                      restoreOriginal(image)
                      progress.dismiss()
                    },
                  },
                ]
              : []),
          ],
        },
      )
    } catch (error) {
      log.error('Обработка не удалась:', error)
      progress.update(describeFailure(error), { tone: 'error' })
    }
  }
}
