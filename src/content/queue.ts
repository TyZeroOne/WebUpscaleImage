import { yieldUntilPainted } from './scheduler'

/**
 * Очередь задач с ограничением параллелизма, прогрессом и отменой.
 *
 * Написана обобщённо (задача — просто асинхронная функция) и ничего не знает
 * про картинки. Причина не в любви к абстракциям: на этапе 4 задачи станут
 * сообщениями в Worker, а на будущем видео-этапе — обработкой кадров.
 * Планирование, счётчики и отмена при этом не меняются.
 */

export interface QueueProgress {
  total: number
  /** Успешно завершено. */
  done: number
  /** Завершено с ошибкой. */
  failed: number
  /** Выполняется прямо сейчас. */
  running: number
}

export type QueueTask<T> = (signal: AbortSignal) => Promise<T>

export interface RunQueueOptions<T> {
  concurrency: number
  signal: AbortSignal
  onProgress?: (progress: QueueProgress) => void
  onItemDone?: (index: number, value: T) => void
  onItemFailed?: (index: number, error: unknown) => void
}

/**
 * Запускает задачи, соблюдая лимит параллелизма.
 *
 * Возвращает итоговое состояние счётчиков. Не бросает исключений: ошибка
 * отдельной задачи — штатное событие (например, картинка закрыта CORS),
 * и она не должна ронять всю очередь.
 */
export async function runQueue<T>(
  tasks: QueueTask<T>[],
  options: RunQueueOptions<T>,
): Promise<QueueProgress> {
  const state: QueueProgress = { total: tasks.length, done: 0, failed: 0, running: 0 }
  const report = (): void => options.onProgress?.({ ...state })

  /**
   * Общий курсор на всех исполнителей.
   *
   * Классический пул: вместо того чтобы заранее делить задачи между
   * исполнителями поровну, каждый берёт следующую свободную. Это важно,
   * когда задачи разной стоимости — а у нас картинки бывают и 200×200,
   * и 4000×3000. При делении поровну один исполнитель закончил бы сразу
   * и простаивал.
   */
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal.aborted) return

      const index = cursor
      cursor += 1
      const task = tasks[index]
      if (!task) return

      state.running += 1
      report()

      try {
        const value = await task(options.signal)
        state.done += 1
        options.onItemDone?.(index, value)
      } catch (error) {
        // Отмена — не ошибка задачи, а решение пользователя: в счётчик
        // неудач она не идёт.
        if (!options.signal.aborted) {
          state.failed += 1
          options.onItemFailed?.(index, error)
        }
      } finally {
        state.running -= 1
      }

      report()

      /**
       * Кадр между задачами.
       *
       * С этапа 4 вычисления идут в воркерах, и главный поток свободен сам
       * по себе — но строка остаётся нужной по двум причинам:
       *
       *  1. Резервный режим. Если воркеры недоступны (политика безопасности
       *     страницы), вычисления снова идут здесь, и без возврата кадра
       *     очередь выполнилась бы одним куском: прогресс не обновился бы
       *     ни разу, а «Отмена» не дошла бы до обработчика.
       *  2. Даже с воркерами получение пикселей, подмена картинки и
       *     обновление панели выполняются в главном потоке. На быстрых
       *     мелких картинках задачи заканчивались бы плотнее, чем браузер
       *     успевает рисовать, и прогресс перескакивал бы рывками.
       */
      await yieldUntilPainted()
    }
  }

  const workers = Array.from({ length: Math.max(1, options.concurrency) }, worker)
  await Promise.all(workers)

  return { ...state }
}
