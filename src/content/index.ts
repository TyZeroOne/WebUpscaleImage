import { createLogger, setVerboseLogging } from '@/core/log'
import { registerMessageHandlers, sendToBackground } from '@/core/messaging'
import { getSettings } from '@/core/settings'
import { createHighlight } from '@/ui/highlight'
import { createOverlayButton } from '@/ui/overlay-button'
import { createProgressPanel } from '@/ui/progress-panel'
import { createToaster } from '@/ui/toast'
import { createVideoBadge } from '@/ui/video-badge'
import { VIDEO_ENHANCEMENT_ENABLED, videoBadgeMode } from '@/video'
import { findImageBySource, scanMedia } from './detect'
import { createEnhanceFlow } from './enhance-flow'
import { createHoverTracker } from './hover'
import { createPageFlow } from './page-flow'
import { getUiRoot } from './ui-root'

/**
 * Content script — код, который Chrome внедряет в каждую http(s)-страницу.
 *
 * Изоляция: у content script общий DOM со страницей, но собственное
 * JS-окружение. Скрипты страницы не видят наших переменных, мы не видим их.
 *
 * Ограничение, определяющее архитектуру: это главный поток страницы.
 * Долгое вычисление здесь заморозит сайт пользователя, поэтому content script
 * навсегда останется детектором и рисовальщиком UI, а считать будет Worker
 * (этап 4).
 */

const log = createLogger('content')

/** Сколько держать рамку вокруг картинки, выбранной через контекстное меню. */
const HIGHLIGHT_DURATION_MS = 1600

function bootstrapUi(): void {
  const { host, layer } = getUiRoot()
  const button = createOverlayButton(layer)
  const toaster = createToaster(layer)
  const highlight = createHighlight(layer)
  const panel = createProgressPanel(layer)
  const badge = createVideoBadge(layer, videoBadgeMode() === 'interactive')

  let hovered: HTMLImageElement | null = null

  createHoverTracker({
    button,
    badge,
    host,
    onChange: (target) => {
      /**
       * Точка расширения под видео. Сейчас плашка над <video> только
       * показывается; когда появится обработка, здесь будет запоминаться
       * элемент, как это уже делается для картинок.
       */
      hovered = target?.kind === 'image' ? target.element : null
    },
  })

  /** Общая точка обработки — и для кнопки, и для контекстного меню (DRY). */
  const enhanceImage = createEnhanceFlow({ toaster })
  const enhancePage = createPageFlow({ panel, toaster })

  button.onClick(() => {
    if (!hovered) return
    void enhanceImage(hovered, 'overlay')
  })

  // Контекстное меню приходит из service worker'а: сам пункт меню живёт там,
  // а картинку по URL умеет найти только страница.
  registerMessageHandlers({
    CONTEXT_MENU_ENHANCE: async (payload) => {
      const image = findImageBySource(payload.srcUrl)
      if (!image) {
        // Реальный случай: картинка внутри iframe, а мы туда не внедряемся,
        // либо страница подменила src между кликом и доставкой сообщения.
        toaster.show('Не удалось найти эту картинку на странице.', { tone: 'error' })
        return { handled: false }
      }
      highlight.showFor(image.getBoundingClientRect(), HIGHLIGHT_DURATION_MS)
      await enhanceImage(image, 'context-menu')
      return { handled: true }
    },

    SCAN_PAGE: () => {
      const media = scanMedia()
      return { url: location.href, images: media.images.length, videos: media.videos.length }
    },

    ENHANCE_PAGE: async () => {
      const result = await enhancePage()
      if (!result.started && result.reason) {
        toaster.show(result.reason, { tone: 'error' })
      }
      return result
    },
  })
}

/**
 * UI и слушатели поднимаются СИНХРОННО, до любого await.
 *
 * То же правило, что и в service worker'е, но по другой причине: пользователь
 * может нажать правой кнопкой на картинку через долю секунды после загрузки
 * страницы. Если бы registerMessageHandlers стоял после `await getSettings()`,
 * сообщение из контекстного меню пришло бы раньше слушателя и потерялось —
 * причём воспроизводилось бы это только на медленной машине.
 */
bootstrapUi()

async function bootstrap(): Promise<void> {
  const settings = await getSettings()
  setVerboseLogging(import.meta.env.DEV || settings.verboseLogging)

  const media = scanMedia()
  log.info(
    `Страница просканирована: изображений ${media.images.length}, ` +
      `видео ${media.videos.length} (обработка видео: ${
        VIDEO_ENHANCEMENT_ENABLED ? 'включена' : 'отключена'
      })`,
  )

  await sendToBackground('PAGE_SCAN', {
    url: location.href,
    images: media.images.length,
    videos: media.videos.length,
  })
}

void bootstrap()
