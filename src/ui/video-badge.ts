/**
 * Плашка над видео.
 *
 * Точка расширения под будущую обработку видео. Сейчас рендерится
 * в отключённом виде: показывает, что расширение видео заметило,
 * но пока с ним ничего не делает.
 *
 * Почему не просто спрятать: место, где появится кнопка, должно быть
 * занято и проверено. Плашка, добавленная вместе с реализацией, — это
 * ещё и вёрстка, и позиционирование, и проверка на десятке плееров.
 * Сделанная заранее, она оставляет будущему этапу только логику.
 */

const ICON_SVG = `
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M12 20V6M12 4l6 7H6l6-7Z" fill="currentColor"/>
  <path d="M5 21h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
</svg>`

/**
 * Отступ от края видео.
 *
 * Больше, чем у кнопки над картинкой (8 px): в правом верхнем углу плееров
 * часто располагаются собственные элементы управления — «во весь экран»,
 * «настройки», «поделиться». Лишние четыре пикселя уменьшают шанс наложиться
 * прямо на них.
 */
const INSET_PX = 12

export interface VideoBadge {
  showFor(rect: DOMRect): void
  hide(): void
  readonly element: HTMLElement
}

export function createVideoBadge(layer: HTMLElement, interactive: boolean): VideoBadge {
  const badge = document.createElement('div')
  badge.className = 'badge'
  badge.dataset.visible = 'false'
  badge.innerHTML = `${ICON_SVG}<span class="label">Видео — скоро</span>`

  /**
   * pointer-events остаётся выключенным, пока плашка неинтерактивна.
   *
   * Это не косметика. Плашка висит поверх плеера, и включённый перехват
   * событий украл бы у пользователя клики по видео — то есть сломал бы
   * воспроизведение ради элемента, который всё равно ничего не делает.
   */
  if (interactive) badge.dataset.interactive = 'true'

  layer.append(badge)

  return {
    element: badge,

    showFor(rect: DOMRect) {
      // Та же система координат, что у кнопки над картинкой: fixed совпадает
      // с координатами getBoundingClientRect, пересчёты не нужны.
      badge.style.top = `${rect.top + INSET_PX}px`
      badge.style.right = `${document.documentElement.clientWidth - rect.right + INSET_PX}px`
      badge.dataset.visible = 'true'
    },

    hide() {
      badge.dataset.visible = 'false'
      badge.style.top = '-9999px'
    },
  }
}
