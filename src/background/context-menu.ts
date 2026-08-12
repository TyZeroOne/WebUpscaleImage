import type { EnhanceOperation } from '@/core/enhance'
import { t } from '@/core/i18n'
import { createLogger } from '@/core/log'
import { sendToTab } from '@/core/messaging'

/**
 * Пункты контекстного меню по правому клику.
 *
 * Зачем они вдобавок к кнопкам при наведении:
 *  - кнопки появляются по hover, а наведения не существует на сенсорных экранах;
 *  - кнопки недоступны с клавиатуры, а контекстное меню открывается клавишей
 *    Menu или Shift+F10;
 *  - Chrome сам определяет, что под курсором картинка (contexts: ['image']),
 *    и делает это надёжнее нашего хит-теста — в том числе внутри iframe.
 */

const log = createLogger('context-menu')

/**
 * Пункты описаны данными, а не четырьмя copy-paste блоками.
 *
 * С появлением второго действия («улучшить качество») число пунктов
 * удвоилось: два действия на картинку и два на страницу. Держать это
 * списком дешевле, чем восемью почти одинаковыми вызовами.
 */
interface MenuItem {
  id: string
  titleKey: string
  context: 'image' | 'page'
  operation: EnhanceOperation
}

const ITEMS: MenuItem[] = [
  {
    id: 'image-enhancer:image-upscale',
    titleKey: 'menuEnhanceImage',
    context: 'image',
    operation: 'upscale',
  },
  {
    id: 'image-enhancer:image-refine',
    titleKey: 'menuRefineImage',
    context: 'image',
    operation: 'refine',
  },
  {
    id: 'image-enhancer:page-upscale',
    titleKey: 'menuEnhancePage',
    context: 'page',
    operation: 'upscale',
  },
  {
    id: 'image-enhancer:page-refine',
    titleKey: 'menuRefinePage',
    context: 'page',
    operation: 'refine',
  },
]

const BY_ID = new Map(ITEMS.map((item) => [item.id, item]))

export function registerContextMenu(): void {
  /**
   * Пункты создаются ТОЛЬКО в onInstalled.
   *
   * Ловушка MV3: service worker выгружается и поднимается заново, и код
   * верхнего уровня выполняется при каждом подъёме. Вызов create() на верхнем
   * уровне модуля привёл бы к ошибке «Cannot create item with duplicate id»
   * на втором и каждом следующем старте.
   *
   * Пункты меню, в отличие от переменных, переживают выгрузку worker'а —
   * их хранит браузер. Поэтому создавать их повторно и не нужно.
   */
  chrome.runtime.onInstalled.addListener(() => {
    // removeAll перед create — на случай обновления расширения, когда старые
    // пункты с теми же id уже зарегистрированы браузером.
    chrome.contextMenus.removeAll(() => {
      for (const item of ITEMS) {
        chrome.contextMenus.create({
          id: item.id,
          title: t(item.titleKey),
          /**
           * Контекст 'image' — правый клик по <img>, Chrome кладёт адрес
           * в info.srcUrl. Контекст 'page' — клик не по картинке, ссылке,
           * выделению или полю ввода. Они взаимно исключают друг друга,
           * поэтому в меню одновременно видны только два пункта из четырёх.
           */
          contexts: [item.context],
        })
      }
    })
  })

  // А вот слушатель регистрируется при каждом подъёме worker'а, синхронно:
  // без него клик по пункту меню будет некому обработать.
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const item = BY_ID.get(String(info.menuItemId))
    if (!item) return

    if (tab?.id === undefined) {
      log.warn('Клик по пункту меню без вкладки — игнорирую')
      return
    }

    if (item.context === 'page') {
      void sendToTab(tab.id, 'ENHANCE_PAGE', { operation: item.operation }).then((response) => {
        if (response && !response.started) {
          log.warn(`Режим «вся страница» не запустился: ${response.reason ?? 'причина неизвестна'}`)
        }
      })
      return
    }

    if (!info.srcUrl) {
      log.warn('В событии нет srcUrl — игнорирую')
      return
    }

    /**
     * frameId из события передаётся дальше, хотя content script у нас
     * внедряется только в главный фрейм (all_frames: false). Если картинка
     * была в iframe, frameId будет ненулевым, сообщение не доставится,
     * и sendToTab честно вернёт null — это лучше, чем молча отправить
     * в главный фрейм и получить «картинка не найдена».
     */
    void sendToTab(
      tab.id,
      'CONTEXT_MENU_ENHANCE',
      { srcUrl: info.srcUrl, operation: item.operation },
      info.frameId ?? 0,
    ).then((response) => {
      if (response?.handled) return
      log.warn('Вкладка не обработала выбор из контекстного меню', {
        frameId: info.frameId,
        srcUrl: info.srcUrl,
      })
    })
  })
}
