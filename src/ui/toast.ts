/**
 * Всплывающие уведомления в углу страницы.
 *
 * Зачем свои, а не chrome.notifications: системные уведомления требуют
 * разрешения `notifications`, показываются вне окна браузера и живут дольше,
 * чем нужно. Для короткого «сделано» / «не получилось» это чрезмерно.
 * Системные уведомления понадобятся позже — для долгой фоновой обработки,
 * когда пользователь уже ушёл с вкладки.
 */

export type ToastTone = 'info' | 'error'

/** Сколько тост висит на экране. */
const DEFAULT_DURATION_MS = 3200

/**
 * Больше трёх одновременно — уже стена текста, закрывающая контент.
 * Самый старый вытесняется.
 */
const MAX_VISIBLE = 3

export interface Toaster {
  show(text: string, tone?: ToastTone, durationMs?: number): void
}

export function createToaster(layer: HTMLElement): Toaster {
  const stack = document.createElement('div')
  stack.className = 'toasts'
  layer.append(stack)

  /**
   * Живые тосты отслеживаются отдельным массивом, а не через stack.children.
   * Причина: удаление отложено на время анимации, и сразу после вызова
   * remove() узел ещё в DOM. Цикл «пока детей больше трёх» по stack.children
   * поэтому никогда бы не завершился.
   */
  const active: HTMLElement[] = []

  const remove = (node: HTMLElement): void => {
    const index = active.indexOf(node)
    if (index >= 0) active.splice(index, 1)
    node.dataset.visible = 'false'
    // Ждём конца перехода прозрачности, потом убираем из DOM.
    // 200 мс с запасом больше 160 мс из CSS.
    setTimeout(() => node.remove(), 200)
  }

  return {
    show(text, tone = 'info', durationMs = DEFAULT_DURATION_MS) {
      const toast = document.createElement('div')
      toast.className = 'toast'
      toast.dataset.tone = tone
      toast.dataset.visible = 'false'
      // Текст через textContent, а не innerHTML: сюда попадают URL картинок
      // и сообщения об ошибках со страницы — то есть данные, которым нельзя
      // доверять. innerHTML здесь был бы XSS внутри нашего же shadow root.
      const dot = document.createElement('span')
      dot.className = 'dot'
      const label = document.createElement('span')
      label.textContent = text
      toast.append(dot, label)
      stack.append(toast)

      /**
       * Чтобы CSS-переход проиграл, у элемента должно быть ЗАФИКСИРОВАНО
       * начальное состояние (opacity: 0) до того, как мы поставим конечное.
       * Только что созданный узел этого состояния ещё не имеет — браузер
       * посчитает стили один раз, уже с opacity: 1, и перехода не будет.
       *
       * Чтение offsetHeight принудительно вызывает пересчёт стилей и
       * компоновки прямо сейчас — этого достаточно, чтобы начальное
       * состояние зафиксировалось.
       *
       * Напрашивающаяся альтернатива — двойной requestAnimationFrame —
       * здесь неверна: в невидимой вкладке кадры не отрисовываются, rAF
       * не вызывается вовсе, и тост навсегда остаётся прозрачным.
       * Проверено на стенде: тост висел в DOM с opacity 0 и удалялся
       * по таймеру, так и не показавшись.
       */
      void toast.offsetHeight
      toast.dataset.visible = 'true'

      active.push(toast)
      while (active.length > MAX_VISIBLE) {
        const oldest = active[0]
        if (!oldest) break
        remove(oldest)
      }

      setTimeout(() => remove(toast), durationMs)
    },
  }
}
