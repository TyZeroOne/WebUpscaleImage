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
 * Сколько задач выполнять одновременно.
 *
 * На этапе 3 значение равно ЕДИНИЦЕ, и это осознанно.
 *
 * Вычисления пока идут в главном потоке страницы и они синхронные: фильтр
 * Ланцоша нельзя прервать на середине. Запустив две задачи «параллельно»,
 * мы не получим ускорения — процессорная часть всё равно выполнится
 * последовательно, потому что поток один. Зато получим:
 *   - удвоенный пик памяти (два набора буферов вместо одного);
 *   - более рваный прогресс: обе задачи закончатся почти одновременно;
 *   - больший шанс, что вкладку убьёт браузер на крупных картинках.
 *
 * Параллелизм начнёт иметь смысл на этапе 4, когда задачи уедут в Worker'ы.
 * Тогда разумное значение — примерно половина логических ядер
 * (navigator.hardwareConcurrency), чтобы оставить браузеру и системе воздух.
 */
export const DEFAULT_CONCURRENCY = 1

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
       * Кадр между задачами — обязателен, а не вежливость.
       *
       * Без него очередь из двадцати картинок выполнилась бы одним куском:
       * прогресс не обновился бы ни разу, а нажатие «Отмена» не дошло бы
       * до обработчика, потому что поток занят. Пользователь увидел бы
       * несколько секунд полностью замершей страницы и никакого способа
       * это прекратить.
       */
      await yieldUntilPainted()
    }
  }

  const workers = Array.from({ length: Math.max(1, options.concurrency) }, worker)
  await Promise.all(workers)

  return { ...state }
}
