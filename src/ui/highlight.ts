/**
 * Рамка вокруг картинки — визуальный ответ на действие пользователя.
 *
 * Нужна там, где действие началось не с наведения: при выборе пункта
 * контекстного меню пользователь смотрит на меню, а не на картинку,
 * и после клика должен понять, какая именно картинка выбрана.
 * На этапе 3 та же рамка покажет, какая картинка обрабатывается сейчас.
 */

/** Насколько рамка выступает за края картинки, px. */
const OUTSET_PX = 2

export interface Highlight {
  showFor(rect: DOMRect, durationMs?: number): void
  hide(): void
}

export function createHighlight(layer: HTMLElement): Highlight {
  const box = document.createElement('div')
  box.className = 'highlight'
  box.dataset.visible = 'false'
  layer.append(box)

  let hideTimer: ReturnType<typeof setTimeout> | undefined

  const hide = (): void => {
    clearTimeout(hideTimer)
    box.dataset.visible = 'false'
  }

  return {
    showFor(rect, durationMs) {
      clearTimeout(hideTimer)
      box.style.top = `${rect.top - OUTSET_PX}px`
      box.style.left = `${rect.left - OUTSET_PX}px`
      box.style.width = `${rect.width + OUTSET_PX * 2}px`
      box.style.height = `${rect.height + OUTSET_PX * 2}px`
      box.dataset.visible = 'true'
      if (durationMs !== undefined) hideTimer = setTimeout(hide, durationMs)
    },
    hide,
  }
}
