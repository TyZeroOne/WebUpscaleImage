/**
 * Всплывающие уведомления в углу страницы.
 *
 * Зачем свои, а не chrome.notifications: системные уведомления требуют
 * разрешения `notifications`, показываются вне окна браузера и живут дольше,
 * чем нужно. Для короткого «сделано» / «не получилось» это чрезмерно.
 * Системные уведомления понадобятся позже — для долгой фоновой обработки,
 * когда пользователь уже ушёл с вкладки.
 */

export type ToastTone = 'info' | 'progress' | 'error'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastOptions {
  tone?: ToastTone
  /** null — не скрывать автоматически (для сообщений о ходе работы). */
  durationMs?: number | null
  actions?: ToastAction[]
}

/** Тост, который можно обновить или убрать после показа. */
export interface ToastHandle {
  update(text: string, options?: ToastOptions): void
  dismiss(): void
}

const DEFAULT_DURATION_MS = 3600

/**
 * Больше трёх одновременно — уже стена текста, закрывающая контент.
 * Самый старый вытесняется.
 */
const MAX_VISIBLE = 3

/** Запас над 160 мс перехода из CSS: узел удаляется, когда анимация закончилась. */
const REMOVE_DELAY_MS = 200

export interface Toaster {
  show(text: string, options?: ToastOptions): ToastHandle
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
    setTimeout(() => node.remove(), REMOVE_DELAY_MS)
  }

  return {
    show(text, options = {}) {
      const toast = document.createElement('div')
      toast.className = 'toast'
      toast.dataset.visible = 'false'

      const dot = document.createElement('span')
      dot.className = 'dot'
      const label = document.createElement('span')
      label.className = 'text'
      const actionsBox = document.createElement('span')
      actionsBox.className = 'actions'
      toast.append(dot, label, actionsBox)

      let hideTimer: ReturnType<typeof setTimeout> | undefined

      const applyOptions = (value: string, opts: ToastOptions): void => {
        // Текст через textContent, а не innerHTML: сюда попадают URL картинок
        // и сообщения об ошибках со страницы — то есть данные, которым нельзя
        // доверять. innerHTML здесь был бы XSS внутри нашего же shadow root.
        label.textContent = value
        toast.dataset.tone = opts.tone ?? 'info'

        actionsBox.replaceChildren()
        for (const action of opts.actions ?? []) {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = action.label
          button.addEventListener('click', (event) => {
            // Та же причина, что и у кнопки-оверлея: событие всплывает
            // до document, где его видят обработчики страницы.
            event.preventDefault()
            event.stopPropagation()
            action.onClick()
          })
          actionsBox.append(button)
        }

        clearTimeout(hideTimer)
        const duration = opts.durationMs === undefined ? DEFAULT_DURATION_MS : opts.durationMs
        if (duration !== null) hideTimer = setTimeout(() => remove(toast), duration)
      }

      applyOptions(text, options)
      stack.append(toast)

      /**
       * Чтобы CSS-переход проиграл, у элемента должно быть ЗАФИКСИРОВАНО
       * начальное состояние (opacity: 0) до того, как мы поставим конечное.
       * Только что созданный узел этого состояния ещё не имеет — браузер
       * посчитает стили один раз, уже с opacity: 1, и перехода не будет.
       *
       * Чтение offsetHeight принудительно вызывает пересчёт стилей и
       * компоновки прямо сейчас — этого достаточно.
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

      return {
        update(nextText, nextOptions = {}) {
          if (!toast.isConnected) return
          applyOptions(nextText, nextOptions)
        },
        dismiss() {
          clearTimeout(hideTimer)
          remove(toast)
        },
      }
    },
  }
}
