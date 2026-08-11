/**
 * Панель хода обработки для режима «вся страница».
 *
 * Почему не тост: тост живёт секунды и не имеет состояния. Здесь нужно
 * показывать меняющийся прогресс минутами и держать кнопку «Отмена»
 * доступной всё это время.
 *
 * Панель ставится в ЛЕВЫЙ нижний угол, а тосты остаются в правом — иначе
 * они перекрывали бы друг друга, а прятать прогресс под уведомлением
 * об ошибке отдельной картинки нельзя: именно в этот момент пользователь
 * и хочет нажать «Отмена».
 */

export interface ProgressPanelState {
  total: number
  done: number
  failed: number
}

export interface ProgressFinishState extends ProgressPanelState {
  cancelled: boolean
}

export interface ProgressPanel {
  show(total: number): void
  update(state: ProgressPanelState): void
  finish(state: ProgressFinishState): void
  hide(): void
  onCancel(handler: () => void): void
  onRestoreAll(handler: () => void): void
}

/** Сколько держать панель на экране после завершения. */
const FINISHED_LINGER_MS = 15_000

export function createProgressPanel(layer: HTMLElement): ProgressPanel {
  const panel = document.createElement('div')
  panel.className = 'panel'
  panel.dataset.visible = 'false'

  const title = document.createElement('div')
  title.className = 'panel-title'

  const bar = document.createElement('div')
  bar.className = 'panel-bar'
  const fill = document.createElement('i')
  bar.append(fill)

  const status = document.createElement('div')
  status.className = 'panel-status'

  const actions = document.createElement('div')
  actions.className = 'panel-actions'

  const cancelButton = document.createElement('button')
  cancelButton.type = 'button'
  cancelButton.textContent = 'Отмена'

  const restoreButton = document.createElement('button')
  restoreButton.type = 'button'
  restoreButton.textContent = 'Вернуть все'
  restoreButton.hidden = true

  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.textContent = 'Закрыть'
  closeButton.hidden = true

  actions.append(cancelButton, restoreButton, closeButton)
  panel.append(title, bar, status, actions)
  layer.append(panel)

  let lingerTimer: ReturnType<typeof setTimeout> | undefined

  const hide = (): void => {
    clearTimeout(lingerTimer)
    panel.dataset.visible = 'false'
  }

  const stopClick = (handler: () => void) => (event: MouseEvent) => {
    // Та же причина, что у кнопки-оверлея: событие всплывает до document,
    // где его видят делегированные обработчики страницы.
    event.preventDefault()
    event.stopPropagation()
    handler()
  }

  closeButton.addEventListener('click', stopClick(hide))

  const renderProgress = (state: ProgressPanelState): void => {
    const processed = state.done + state.failed
    const percent = state.total === 0 ? 0 : Math.round((processed / state.total) * 100)
    fill.style.width = `${percent}%`
    status.textContent =
      state.failed > 0
        ? `${processed} из ${state.total} · пропущено: ${state.failed}`
        : `${processed} из ${state.total}`
  }

  return {
    show(total) {
      clearTimeout(lingerTimer)
      title.textContent = 'Улучшаю изображения'
      cancelButton.hidden = false
      restoreButton.hidden = true
      closeButton.hidden = true
      renderProgress({ total, done: 0, failed: 0 })
      panel.dataset.visible = 'true'
      panel.dataset.state = 'running'
    },

    update: renderProgress,

    finish(state) {
      renderProgress(state)
      panel.dataset.state = state.cancelled ? 'cancelled' : 'done'
      title.textContent = state.cancelled ? 'Обработка остановлена' : 'Готово'
      cancelButton.hidden = true
      // Возвращать нечего, если ни одна картинка не заменилась.
      restoreButton.hidden = state.done === 0
      closeButton.hidden = false
      lingerTimer = setTimeout(hide, FINISHED_LINGER_MS)
    },

    hide,

    onCancel(handler) {
      cancelButton.addEventListener('click', stopClick(handler))
    },

    onRestoreAll(handler) {
      restoreButton.addEventListener(
        'click',
        stopClick(() => {
          handler()
          restoreButton.hidden = true
        }),
      )
    },
  }
}
