import { NothingToDoError, resolvePlan, resolveScale, resolveTargetSize } from '@/core/enhance'
import type { EnhanceOperation, NothingToDoReason, QualityLevel, TargetSize } from '@/core/enhance'
import type { Settings } from '@/core/settings'
import { getSettings } from '@/core/settings'
import { t } from '@/core/i18n'
import { createLogger } from '@/core/log'
import { sendToBackground } from '@/core/messaging'
import type { EnhanceTrigger } from '@/core/messaging'
import type { Toaster } from '@/ui/toast'
import { buildFileName, downloadBlob, replaceOnPage, restoreOriginal } from './apply-result'
import { isWorkerModeActive, runEnhance } from './enhance-runner'
import { modelSynthesizesDetail } from './ml-client'
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
  if (error instanceof NothingToDoError) {
    switch (error.reason) {
      case 'same-size':
        return t('errSameSize')
      case 'refine-no-op':
        return t('errRefineNoOp')
      case 'refine-too-large':
        return t('errRefineTooLarge')
    }
  }
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

export { NothingToDoError }

/**
 * Изменит ли операция «улучшить качество» хоть что-нибудь.
 *
 * Улучшение складывается ровно из двух вкладов: модель, синтезирующая детали,
 * и нерезкое маскирование. Уберите оба — и остаётся тождественное
 * преобразование: конвейер честно отработает, вернёт те же пиксели, подменит
 * картинку на странице файлом, который может весить больше оригинала,
 * и отрапортует «Готово». Пользователь при этом не увидит никакой разницы
 * и будет прав.
 *
 * Проверка намеренно консервативна: она отвечает «нечего делать» только тогда,
 * когда это известно ТОЧНО, без загрузки модели. Случай «модель подходит,
 * но картинка для неё слишком велика» здесь не виден и ловится позже,
 * уже в runRefine.
 */
export function refineChangesNothing(level: QualityLevel, settings: Settings): boolean {
  const modelHelps = resolvePlan(level).useMl && modelSynthesizesDetail(settings.model)
  return !modelHelps && settings.sharpen === 0
}

/**
 * Целевой размер — нужен ещё до начала работы, чтобы показать его в UI.
 *
 * Два режима определения коэффициента:
 *  - 'auto' — от того, насколько картинке не хватает пикселей на экране;
 *  - 'longest-side' — привести длинную сторону к заданному числу, хоть вверх,
 *    хоть вниз.
 *
 * `skip` — не булев флаг, а причина отказа или null. Причин две, и сообщения
 * у них разные: «картинка уже нужного размера» в ответ на просьбу улучшить
 * качество сбивало бы с толку, ведь размер тут ни при чём.
 */
export function planEnhance(
  image: HTMLImageElement,
  level: QualityLevel,
  settings: Settings,
  operation: EnhanceOperation = 'upscale',
  targetSize?: TargetSize,
): {
  scale: number
  width: number
  height: number
  skip: NothingToDoReason | null
  targetSize?: TargetSize
} {
  /**
   * Размер задан пользователем явно — планировать нечего.
   *
   * Ни потолок увеличения из уровня качества, ни настройка «длинная сторона»,
   * ни галочка «не трогать крупные» здесь не применяются, и это намеренно:
   * все они существуют, чтобы УГАДАТЬ желаемый размер, когда пользователь
   * его не назвал. Он назвал.
   *
   * Единственная причина отказа — попросили ровно то, что уже есть.
   */
  if (operation === 'resize' && targetSize) {
    const same =
      targetSize.width === image.naturalWidth && targetSize.height === image.naturalHeight
    return {
      scale: targetSize.width / Math.max(1, image.naturalWidth),
      width: targetSize.width,
      height: targetSize.height,
      skip: same ? 'same-size' : null,
      targetSize,
    }
  }

  /**
   * Улучшение качества не меняет размер, поэтому ни целевой размер,
   * ни потолок увеличения к нему не относятся. И отсеивать по размеру нечего:
   * «картинка уже достаточно большая» — не довод против улучшения качества.
   * Единственный повод отказаться — что улучшать её нечем.
   */
  if (operation === 'refine') {
    return {
      scale: 1,
      width: image.naturalWidth,
      height: image.naturalHeight,
      skip: refineChangesNothing(level, settings) ? 'refine-no-op' : null,
    }
  }

  const maxScale = resolvePlan(level).maxScale

  /**
   * Кнопка «Увеличить» считает коэффициент от того, насколько картинке
   * не хватает пикселей на экране, и другого режима у неё больше нет.
   *
   * Настройка «привести длинную сторону к N» удалена на этапе 13:
   * с появлением диалога размера она стала вторым, спрятанным местом,
   * определяющим то же самое. Кто хочет конкретное число — называет его
   * в диалоге; кнопка же означает ровно «сделай побольше».
   */
  const displayWidth = image.getBoundingClientRect().width
  const scale = resolveScale(displayWidth, image.naturalWidth, window.devicePixelRatio, maxScale)
  const target = resolveTargetSize(image.naturalWidth, image.naturalHeight, scale)
  return { scale, width: target.width, height: target.height, skip: null }
}

/**
 * Обработка без какого-либо UI. Бросает исключение при неудаче —
 * вызывающая сторона решает, как о ней сообщить.
 */
export async function enhanceImageCore(
  image: HTMLImageElement,
  trigger: EnhanceTrigger,
  operation: EnhanceOperation,
  requestedSize?: TargetSize,
  signal?: AbortSignal,
): Promise<EnhanceOutcome> {
  if (inFlight.has(image)) throw new AlreadyRunningError()
  inFlight.add(image)

  const sourceUrl = image.currentSrc || image.src
  const level = await resolveQualityLevel()
  const settings = await getSettings()
  const { scale, skip, targetSize } = planEnhance(image, level, settings, operation, requestedSize)

  /**
   * Отказ до всякой работы: картинка уже подходит под заданный размер.
   * Проверяется здесь, а не только в очереди, чтобы одиночный клик тоже
   * получал внятный ответ, а не молча ничего не делал.
   */
  if (skip) {
    inFlight.delete(image)
    throw new NothingToDoError(skip)
  }

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
    const result = await runEnhance(
      { bitmap, sourceUrl },
      { level, scale, sharpen: settings.sharpen, targetSize },
      settings.model,
      settings.mlStrength,
      operation,
      signal,
    )

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
    operation: EnhanceOperation = 'upscale',
    requestedSize?: TargetSize,
  ): Promise<void> {
    const level = await resolveQualityLevel()
    const plan = planEnhance(image, level, await getSettings(), operation, requestedSize)

    // Отказываем сразу, не показывая уведомление о начале работы:
    // мигающее «обрабатываю» перед отказом только сбивает с толку.
    if (plan.skip) {
      toaster.show(describeFailure(new NothingToDoError(plan.skip)))
      return
    }

    const progress = toaster.show(
      operation === 'refine'
        ? t('toastRefining', `${image.naturalWidth}×${image.naturalHeight}`)
        : t(
            'toastProcessing',
            `${image.naturalWidth}×${image.naturalHeight}`,
            `${plan.width}×${plan.height}`,
          ),
      { tone: 'progress', durationMs: null },
    )

    try {
      const outcome = await enhanceImageCore(image, trigger, operation, requestedSize)
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
