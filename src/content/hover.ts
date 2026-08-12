import type { OverlayActions } from '@/ui/overlay-actions'
import type { VideoBadge } from '@/ui/video-badge'
import { MIN_VIDEO_SIDE_PX, videoBadgeMode } from '@/video'
import { isEnhanceableImage } from './detect'

/**
 * Отслеживание картинки под курсором.
 *
 * ПОЧЕМУ ЗДЕСЬ НЕТ MutationObserver
 *
 * Напрашивающееся решение — найти все <img> при старте, повесить на каждую
 * слушатели mouseenter/mouseleave, а через MutationObserver добавлять
 * слушатели новым картинкам. Так делают многие расширения, и это плохо
 * работает по трём причинам:
 *
 *  1. Сотни слушателей вместо одного — на ленте с бесконечной прокруткой
 *     их число растёт без предела.
 *  2. MutationObserver на всём документе срабатывает на каждое изменение DOM.
 *     На современном сайте это тысячи вызовов в минуту, каждый из которых
 *     мы обязаны обработать быстро, иначе тормозит сайт.
 *  3. Всё равно не покрывает случай, когда картинка не менялась, а просто
 *     догрузилась и изменила размер.
 *
 * Вместо этого — ОДИН слушатель на документе (делегирование событий).
 * Он автоматически работает с картинками, появившимися после загрузки,
 * потому что вопрос «что под курсором» решается в момент наведения,
 * а не заранее.
 *
 * MutationObserver ещё может понадобиться на этапе 3, где нужен актуальный
 * СПИСОК картинок для очереди, а не одна текущая. Это другая задача.
 */

/**
 * Что сейчас под курсором.
 *
 * До этапа 8 отслеживались только картинки. Видео добавлено как точка
 * расширения: механика наведения, позиционирования и пересчёта при прокрутке
 * у них общая, различается только показываемый элемент.
 */
export type MediaTarget =
  | { kind: 'image'; element: HTMLImageElement }
  | { kind: 'video'; element: HTMLVideoElement }

export interface HoverTrackerOptions {
  actions: OverlayActions
  badge: VideoBadge
  /** Элемент-хозяин shadow root: наведение на него не считается уходом с медиа. */
  host: HTMLElement
  onChange: (target: MediaTarget | null) => void
}

/**
 * Сколько верхних элементов под курсором просматривать в поисках картинки.
 * Картинку часто перекрывают прозрачные слои: ссылка-обёртка, градиент
 * подписи, невидимый div для перехвата кликов. Трёх-четырёх слоёв хватает
 * в подавляющем большинстве случаев, а перебирать весь стек (он бывает
 * из полутора десятков элементов) — лишняя работа на каждом движении мыши.
 */
const HIT_TEST_DEPTH = 5

export function createHoverTracker(options: HoverTrackerOptions): { destroy: () => void } {
  const { actions, badge, host, onChange } = options
  const badgeMode = videoBadgeMode()

  let current: MediaTarget | null = null
  let frame = 0

  const hideAll = (): void => {
    actions.hide()
    badge.hide()
  }

  const showFor = (target: MediaTarget): void => {
    const rect = target.element.getBoundingClientRect()
    if (target.kind === 'image') {
      badge.hide()
      actions.showFor(rect)
      return
    }
    actions.hide()
    badge.showFor(rect)
  }

  const setCurrent = (target: MediaTarget | null): void => {
    if (target?.element === current?.element) return
    current = target
    onChange(target)
    if (target) showFor(target)
    else hideAll()
  }

  /** Годится ли видео для показа плашки. */
  const isTrackableVideo = (video: HTMLVideoElement): boolean => {
    if (badgeMode === 'hidden') return false
    // videoWidth === 0 — метаданные ещё не загрузились, размеров нет.
    if (video.videoWidth === 0) return false
    const rect = video.getBoundingClientRect()
    return rect.width >= MIN_VIDEO_SIDE_PX && rect.height >= MIN_VIDEO_SIDE_PX
  }

  /**
   * Ищем медиа под точкой, а не смотрим на event.target.
   *
   * event.target даёт самый верхний элемент, который принял событие.
   * Если картинка накрыта прозрачным <a> или <div> (типовой приём в
   * галереях и лентах), target будет этим слоем, а не <img>, и кнопка
   * просто не появится. Хит-тест по координатам решает это.
   *
   * Для видео это тем более важно: плееры почти всегда накрывают видео
   * слоем с элементами управления, и <video> не бывает верхним элементом.
   */
  const mediaAtPoint = (x: number, y: number): MediaTarget | null | 'own-ui' => {
    const stack = document.elementsFromPoint(x, y)
    for (let i = 0; i < Math.min(stack.length, HIT_TEST_DEPTH); i++) {
      const element = stack[i]
      if (!element) break
      // Наш собственный UI. Shadow root закрыт, поэтому elementsFromPoint
      // возвращает host-элемент, а не то, что внутри него.
      if (element === host) return 'own-ui'
      if (element instanceof HTMLImageElement) {
        return isEnhanceableImage(element) ? { kind: 'image', element } : null
      }
      if (element instanceof HTMLVideoElement) {
        return isTrackableVideo(element) ? { kind: 'video', element } : null
      }
    }
    return null
  }

  const handlePointer = (event: MouseEvent): void => {
    const found = mediaAtPoint(event.clientX, event.clientY)
    // Курсор перешёл на наши кнопки — текущий элемент не сбрасываем,
    // иначе кнопка исчезала бы ровно в момент попытки на неё нажать.
    if (found === 'own-ui') return
    setCurrent(found)
  }

  /**
   * При прокрутке и изменении размера окна картинка едет, а кнопка,
   * позиционированная fixed, — нет. Позицию нужно пересчитывать.
   *
   * Пересчёт привязан к requestAnimationFrame, а не выполняется прямо
   * в обработчике: события scroll приходят чаще, чем браузер перерисовывает
   * кадр, и getBoundingClientRect в каждом из них — это forced reflow,
   * то есть заметное подтормаживание прокрутки на слабой машине.
   */
  const reposition = (): void => {
    if (!current) return
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (!current) return
      // Элемент могли удалить из DOM во время прокрутки (виртуальные списки).
      if (!current.element.isConnected) {
        setCurrent(null)
        return
      }
      const rect = current.element.getBoundingClientRect()
      // Ушёл за пределы окна — прячем, чтобы не висело над посторонним
      // содержимым.
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
        setCurrent(null)
        return
      }
      showFor(current)
    })
  }

  // capture: true — событие ловится на пути вниз, до обработчиков страницы.
  // Некоторые сайты вызывают stopPropagation на своих контейнерах, и без
  // capture мы бы просто не узнали о наведении.
  document.addEventListener('mouseover', handlePointer, { capture: true, passive: true })
  // Прокрутка может идти внутри вложенного контейнера, а не окна, поэтому
  // тоже capture: события scroll не всплывают.
  document.addEventListener('scroll', reposition, { capture: true, passive: true })
  window.addEventListener('resize', reposition, { passive: true })

  return {
    destroy() {
      document.removeEventListener('mouseover', handlePointer, { capture: true })
      document.removeEventListener('scroll', reposition, { capture: true })
      window.removeEventListener('resize', reposition)
      if (frame) cancelAnimationFrame(frame)
    },
  }
}
