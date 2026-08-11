import { createLogger, setVerboseLogging } from '@/core/log'
import { sendToBackground } from '@/core/messaging'
import { getSettings } from '@/core/settings'
import { VIDEO_ENHANCEMENT_ENABLED } from '@/video'
import { scanMedia } from './detect'

/**
 * Content script — код, который Chrome внедряет в каждую http(s)-страницу.
 *
 * Важное про изоляцию: content script живёт в «изолированном мире». У него
 * общий DOM со страницей, но собственный набор JS-объектов. Скрипты страницы
 * не видят наших переменных, а мы не видим их. Это защищает и нас, и страницу.
 *
 * Ограничение, которое определит архитектуру дальше: здесь НЕЛЬЗЯ считать
 * тяжёлые вещи. Это тот же поток, что и UI страницы — любая долгая операция
 * подвесит сайт пользователя. Поэтому вычисления уедут в Worker (этап 4),
 * а content script останется только детектором и рисовальщиком оверлеев.
 */

const log = createLogger('content')

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

  const response = await sendToBackground('PAGE_SCAN', {
    url: location.href,
    images: media.images.length,
    videos: media.videos.length,
  })

  log.debug('Ответ service worker:', response)
}

void bootstrap()
