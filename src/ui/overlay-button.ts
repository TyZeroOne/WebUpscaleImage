import { t } from '@/core/i18n'

/**
 * Кнопка «Улучшить», всплывающая над картинкой при наведении.
 *
 * КЛЮЧЕВОЕ АРХИТЕКТУРНОЕ РЕШЕНИЕ: кнопка в единственном экземпляре.
 *
 * Напрашивается создать по кнопке на каждую картинку и прятать их через CSS
 * `:hover`. Так делать нельзя: на странице бывают сотни картинок, и это
 * сотни лишних узлов DOM, каждый со своим слушателем и своим пересчётом
 * стилей при прокрутке. На бесконечной ленте их число растёт неограниченно.
 *
 * Один экземпляр, который переставляется к текущей картинке, стоит столько же
 * при одной картинке и при тысяче.
 */

const ICON_SVG = `
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M12 20V6M12 4l6 7H6l6-7Z" fill="currentColor"/>
  <path d="M5 21h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
</svg>`

/** Отступ кнопки от края картинки, px. */
const INSET_PX = 8

/** Минимальная ширина картинки, при которой на кнопке помещается подпись. */
const COMPACT_BELOW_PX = 148

export interface OverlayButton {
  /** Показать кнопку в правом верхнем углу указанного прямоугольника. */
  showFor(rect: DOMRect): void
  hide(): void
  onClick(handler: () => void): void
  /** Элемент кнопки — нужен, чтобы отличать наведение на неё от наведения на страницу. */
  readonly element: HTMLButtonElement
}

export function createOverlayButton(layer: HTMLElement): OverlayButton {
  const button = document.createElement('button')
  button.className = 'button'
  button.type = 'button'
  button.dataset.visible = 'false'
  button.setAttribute('aria-label', t('overlayEnhanceAria'))
  // innerHTML только для собственной константы с иконкой; подпись —
  // отдельным узлом через textContent, потому что приходит из локализации.
  button.innerHTML = ICON_SVG
  const label = document.createElement('span')
  label.className = 'label'
  label.textContent = t('overlayEnhance')
  button.append(label)
  layer.append(button)

  return {
    element: button,

    showFor(rect: DOMRect) {
      button.dataset.compact = String(rect.width < COMPACT_BELOW_PX)

      /**
       * Координаты берутся из getBoundingClientRect() и ставятся как есть,
       * потому что кнопка позиционируется fixed — то есть в той же системе
       * координат, что и результат getBoundingClientRect (относительно окна).
       *
       * Если бы кнопка была absolute, пришлось бы прибавлять scrollX/scrollY
       * и учитывать все transform у предков картинки. Fixed убирает оба
       * источника ошибок.
       */
      button.style.top = `${rect.top + INSET_PX}px`
      // right отсчитывается от правого края окна, отсюда вычитание.
      button.style.right = `${document.documentElement.clientWidth - rect.right + INSET_PX}px`
      button.dataset.visible = 'true'
    },

    hide() {
      button.dataset.visible = 'false'
      // Кнопка остаётся в DOM, но убирается за пределы окна: иначе, пока
      // идёт анимация исчезновения, она продолжала бы ловить клики.
      button.style.top = '-9999px'
    },

    onClick(handler: () => void) {
      button.addEventListener('click', (event) => {
        /**
         * stopPropagation обязателен, но не по очевидной причине.
         *
         * Кнопка лежит в нашем shadow root, а не внутри вёрстки страницы,
         * поэтому клик по ней не может «нажать» ссылку, в которую обёрнута
         * картинка. Зато событие всплывает до document — и уже там его
         * видят делегированные обработчики страницы (`document.on('click')`),
         * которыми пользуются почти все SPA, галереи и лайтбоксы.
         * Для них это будет клик по элементу <image-enhancer-root>,
         * и реакция может быть любой: закрыть галерею, свернуть меню,
         * перейти по маршруту.
         *
         * Проверено на стенде: без stopPropagation обработчик документа
         * получал событие с target = image-enhancer-root.
         */
        event.preventDefault()
        event.stopPropagation()
        handler()
      })
    },
  }
}
