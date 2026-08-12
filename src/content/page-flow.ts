import { t } from '@/core/i18n'
import { createLogger } from '@/core/log'
import type { ProgressPanel } from '@/ui/progress-panel'
import type { Toaster } from '@/ui/toast'
import { hasOriginal, restoreOriginal } from './apply-result'
import { scanMedia } from './detect'
import { getSettings } from '@/core/settings'
import { describeFailure, enhanceImageCore, planEnhance } from './enhance-flow'
import { resolveConcurrency } from './enhance-runner'
import { runQueue } from './queue'
import { resolveQualityLevel } from './quality'

/**
 * Режим «вся страница»: обработать все подходящие картинки очередью.
 */

const log = createLogger('page-flow')

/**
 * Потолок числа картинок за один запуск.
 *
 * Ограничение по памяти, а не по времени. Каждая обработанная картинка
 * остаётся на странице в виде Blob, который держится объектным URL до тех пор,
 * пока пользователь не вернёт оригинал. Апскейл среднего изображения весит
 * 1-3 МБ; пятьдесят штук — это уже больше сотни мегабайт, добавленных
 * к обычному расходу вкладки.
 *
 * Если картинок больше, обрабатываются первые 50 по приоритету видимости,
 * и пользователю об этом прямо сообщается: молча обработать половину
 * и сделать вид, что всё сделано, — худший вариант.
 */
const MAX_BATCH_SIZE = 50

export interface PageFlowDeps {
  panel: ProgressPanel
  toaster: Toaster
}

export interface PageFlowStartResult {
  started: boolean
  total: number
  reason?: string
}

/**
 * Порядок обработки: сначала то, что ближе к центру экрана.
 *
 * Пользователь смотрит на видимую часть страницы. Если обрабатывать
 * в порядке следования в DOM, первые результаты могут появиться где-то
 * далеко внизу, и первые несколько секунд будет казаться, что ничего
 * не происходит. Сортировка по удалённости от центра экрана даёт видимый
 * результат сразу.
 */
function byViewportPriority(a: HTMLImageElement, b: HTMLImageElement): number {
  const center = window.innerHeight / 2
  const distance = (image: HTMLImageElement): number => {
    const rect = image.getBoundingClientRect()
    return Math.abs(rect.top + rect.height / 2 - center)
  }
  return distance(a) - distance(b)
}

export function createPageFlow({ panel, toaster }: PageFlowDeps) {
  /**
   * Контроллер текущего запуска. Живёт между вызовами, потому что «Отмена»
   * нажимается уже после того, как start() вернул управление.
   */
  let controller: AbortController | null = null
  /** Картинки, заменённые в текущем запуске, — для кнопки «Вернуть все». */
  let processed: HTMLImageElement[] = []

  panel.onCancel(() => {
    log.info('Отмена по требованию пользователя')
    controller?.abort()
  })

  panel.onRestoreAll(() => {
    let restored = 0
    for (const image of processed) {
      if (restoreOriginal(image)) restored += 1
    }
    processed = []
    toaster.show(t('pageRestored', restored))
  })

  return async function enhancePage(): Promise<PageFlowStartResult> {
    if (controller) {
      return { started: false, total: 0, reason: t('pageBusy') }
    }

    /**
     * Список картинок снимается ОДИН РАЗ, на старте.
     *
     * Отслеживать появление новых через MutationObserver сознательно
     * не стали: на странице с ленивой загрузкой картинки появляются
     * по мере прокрутки, и очередь никогда бы не заканчивалась — а значит,
     * прогресс «N из M» терял бы смысл, потому что M рос бы на ходу.
     *
     * Следствие, которое надо знать: на страницах с ленивой загрузкой
     * обрабатывается только то, что уже загружено. Чтобы захватить больше,
     * нужно сначала прокрутить страницу.
     */
    const settings = await getSettings()
    const level = await resolveQualityLevel()

    /**
     * Картинки, уже подходящие под заданный размер, отсеиваются ДО очереди,
     * а не отбраковываются внутри неё.
     *
     * Разница видна пользователю: в счётчике «N из M» знаменатель показывает
     * реальный объём работы. Отбраковка внутри дала бы «40 из 40, пропущено 37» —
     * формально верно и совершенно нечитаемо.
     */
    const candidates = scanMedia()
      .images.filter((image) => !hasOriginal(image))
      .filter((image) => !planEnhance(image, level, settings).skip)
      .sort(byViewportPriority)

    if (candidates.length === 0) {
      return {
        started: false,
        total: 0,
        reason: settings.targetMode === 'longest-side' ? t('pageAllBigEnough') : t('pageNoImages'),
      }
    }

    const batch = candidates.slice(0, MAX_BATCH_SIZE)
    const skipped = candidates.length - batch.length

    controller = new AbortController()
    processed = []
    panel.show(batch.length)

    if (skipped > 0) {
      toaster.show(t('pageBatchTrimmed', batch.length, skipped))
    }

    // Запуск не ожидается: вызывающая сторона должна получить ответ сразу,
    // чтобы popup успел закрыться, а очередь продолжила работать.
    void (async () => {
      const tasks = batch.map((image) => async (signal: AbortSignal) => {
        const outcome = await enhanceImageCore(image, 'page', signal)
        processed.push(image)
        return outcome
      })

      const failures = new Map<string, number>()

      const result = await runQueue(tasks, {
        // Считается один раз на запуск: зависит от того, поднялись ли воркеры,
        // а это выясняется при первой попытке их создать.
        concurrency: resolveConcurrency(),
        signal: controller.signal,
        onProgress: (progress) => panel.update(progress),
        onItemFailed: (index, error) => {
          const reason = describeFailure(error)
          failures.set(reason, (failures.get(reason) ?? 0) + 1)
          log.warn(`Картинка ${index} пропущена: ${reason}`)
        },
      })

      const cancelled = controller?.signal.aborted ?? false
      panel.finish({ ...result, cancelled })

      /**
       * Причины неудач показываются СГРУППИРОВАННО, одним тостом на причину.
       * На странице, где все картинки лежат на CDN без CORS-заголовков,
       * пропущены будут все — и сорок одинаковых уведомлений подряд
       * не сообщили бы ничего сверх одного.
       */
      for (const [reason, count] of failures) {
        toaster.show(count > 1 ? t('failureGrouped', reason, count) : reason, { tone: 'error' })
      }

      log.info(
        `Очередь завершена: успешно ${result.done}, пропущено ${result.failed}` +
          (cancelled ? ' (отменено)' : ''),
      )
      controller = null
    })()

    return { started: true, total: batch.length }
  }
}
