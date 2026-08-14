import type { EnhanceOperation } from '@/core/enhance'
import { t } from '@/core/i18n'

/**
 * Кнопки действий, всплывающие над картинкой при наведении.
 *
 * КЛЮЧЕВОЕ АРХИТЕКТУРНОЕ РЕШЕНИЕ: группа в единственном экземпляре.
 *
 * Напрашивается создать кнопки на каждую картинку и прятать их через CSS
 * `:hover`. Так делать нельзя: на странице бывают сотни картинок, и это
 * сотни лишних узлов DOM, каждый со своим пересчётом стилей при прокрутке.
 * На бесконечной ленте их число растёт неограниченно.
 *
 * Один экземпляр, который переставляется к текущей картинке, стоит столько же
 * при одной картинке и при тысяче.
 */

const ICON_UPSCALE = `
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M12 20V6M12 4l6 7H6l6-7Z" fill="currentColor"/>
  <path d="M5 21h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
</svg>`

/**
 * Иконка улучшения качества: та же рамка кадра, что и у картинки,
 * плюс «искры». Намеренно без стрелок — они читаются как изменение размера,
 * а размер здесь как раз не меняется.
 */
const ICON_REFINE = `
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="2"/>
  <path d="M9 13.5l1.1-2.4L12.5 10l-2.4-1.1L9 6.5 7.9 8.9 5.5 10l2.4 1.1L9 13.5Z" fill="currentColor"/>
  <path d="M16 16l.6-1.4 1.4-.6-1.4-.6L16 12l-.6 1.4-1.4.6 1.4.6L16 16Z" fill="currentColor"/>
</svg>`

/**
 * Иконка выбора размера: рамка и уголки, как у инструмента кадрирования.
 * Стрелок нет намеренно — направление здесь не выбирают, оно выводится
 * из введённых чисел.
 */
const ICON_RESIZE = `
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="2"/>
  <path d="M7 10V9h2M17 14v1h-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M8 15l8-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`

/** Отступ группы от края картинки, px. */
const INSET_PX = 8

/**
 * Ниже этой ширины подписи убираются, остаются только иконки.
 *
 * Порог рос вместе с числом кнопок: 148 при одной, 260 при двух,
 * 340 при трёх. С подписями группа занимает около 320 px, и на картинке
 * в 340 px она закрыла бы почти всё.
 */
const COMPACT_BELOW_PX = 340

export interface OverlayActions {
  /** Показать группу в правом верхнем углу указанного прямоугольника. */
  showFor(rect: DOMRect): void
  hide(): void
  onAction(handler: (operation: EnhanceOperation) => void): void
  /** Контейнер — нужен, чтобы отличать наведение на него от наведения на страницу. */
  readonly element: HTMLElement
}

function createButton(operation: EnhanceOperation, icon: string, labelKey: string, ariaKey: string) {
  const button = document.createElement('button')
  button.className = 'action'
  button.type = 'button'
  button.dataset.operation = operation
  button.setAttribute('aria-label', t(ariaKey))
  // innerHTML только для собственной константы с иконкой; подпись —
  // отдельным узлом через textContent, потому что приходит из локализации.
  button.innerHTML = icon
  const label = document.createElement('span')
  label.className = 'label'
  label.textContent = t(labelKey)
  button.append(label)
  return button
}

export function createOverlayActions(layer: HTMLElement): OverlayActions {
  const group = document.createElement('div')
  group.className = 'actions-group'
  group.dataset.visible = 'false'

  const upscale = createButton('upscale', ICON_UPSCALE, 'overlayEnhance', 'overlayEnhanceAria')
  const refine = createButton('refine', ICON_REFINE, 'overlayRefine', 'overlayRefineAria')
  const resize = createButton('resize', ICON_RESIZE, 'overlayResize', 'overlayResizeAria')
  group.append(upscale, refine, resize)
  layer.append(group)

  return {
    element: group,

    showFor(rect: DOMRect) {
      group.dataset.compact = String(rect.width < COMPACT_BELOW_PX)

      /**
       * Координаты берутся из getBoundingClientRect() и ставятся как есть,
       * потому что группа позиционируется fixed — то есть в той же системе
       * координат, что и результат getBoundingClientRect (относительно окна).
       *
       * Если бы она была absolute, пришлось бы прибавлять scrollX/scrollY
       * и учитывать все transform у предков картинки.
       */
      group.style.top = `${rect.top + INSET_PX}px`
      // right отсчитывается от правого края окна, отсюда вычитание.
      group.style.right = `${document.documentElement.clientWidth - rect.right + INSET_PX}px`
      group.dataset.visible = 'true'
    },

    hide() {
      group.dataset.visible = 'false'
      // Группа остаётся в DOM, но убирается за пределы окна: иначе, пока
      // идёт анимация исчезновения, она продолжала бы ловить клики.
      group.style.top = '-9999px'
    },

    onAction(handler: (operation: EnhanceOperation) => void) {
      group.addEventListener('click', (event) => {
        const target = (event.target as Element | null)?.closest('button.action')
        if (!(target instanceof HTMLButtonElement)) return

        /**
         * stopPropagation обязателен, но не по очевидной причине.
         *
         * Кнопки лежат в нашем shadow root, а не внутри вёрстки страницы,
         * поэтому клик по ним не может «нажать» ссылку, в которую обёрнута
         * картинка. Зато событие всплывает до document — и уже там его
         * видят делегированные обработчики страницы, которыми пользуются
         * почти все SPA, галереи и лайтбоксы.
         */
        event.preventDefault()
        event.stopPropagation()
        handler(target.dataset.operation as EnhanceOperation)
      })
    },
  }
}
