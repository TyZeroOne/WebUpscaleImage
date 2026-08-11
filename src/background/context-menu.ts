import { createLogger } from '@/core/log'
import { sendToTab } from '@/core/messaging'

/**
 * Пункт «Улучшить изображение» в контекстном меню по правому клику.
 *
 * Зачем он нужен вдобавок к кнопке при наведении:
 *  - кнопка недоступна с клавиатуры (она появляется только по hover),
 *    а контекстное меню открывается клавишей Menu или Shift+F10;
 *  - на сенсорных экранах наведения не существует вовсе;
 *  - Chrome сам определяет, что под курсором картинка (contexts: ['image']),
 *    и делает это надёжнее нашего хит-теста — в том числе внутри iframe.
 */

const log = createLogger('context-menu')

const MENU_IMAGE_ID = 'image-enhancer:enhance-image'
const MENU_PAGE_ID = 'image-enhancer:enhance-page'

export function registerContextMenu(): void {
  /**
   * Пункт создаётся ТОЛЬКО в onInstalled.
   *
   * Ловушка MV3: service worker выгружается и поднимается заново, и код
   * верхнего уровня выполняется при каждом подъёме. Вызов create() на верхнем
   * уровне модуля привёл бы к ошибке
   * «Cannot create item with duplicate id» на втором и каждом следующем старте.
   *
   * Пункты меню, в отличие от переменных, переживают выгрузку worker'а —
   * их хранит браузер. Поэтому создавать их повторно и не нужно.
   */
  chrome.runtime.onInstalled.addListener(() => {
    // removeAll перед create — на случай обновления расширения, когда старый
    // пункт с тем же id уже зарегистрирован браузером.
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU_IMAGE_ID,
        title: 'Улучшить это изображение',
        // contexts: ['image'] — пункт показывается только по правому клику
        // на <img>. Chrome при этом кладёт в info.srcUrl адрес картинки.
        contexts: ['image'],
      })
      /**
       * Второй пункт — на пустом месте страницы. Контекст 'page' означает
       * «правый клик не по картинке, ссылке, выделению или полю ввода»,
       * поэтому два наших пункта никогда не появятся в меню одновременно.
       */
      chrome.contextMenus.create({
        id: MENU_PAGE_ID,
        title: 'Улучшить все изображения на странице',
        contexts: ['page'],
      })
    })
  })

  // А вот слушатель регистрируется при каждом подъёме worker'а, синхронно:
  // без него клик по пункту меню будет некому обработать.
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_IMAGE_ID && info.menuItemId !== MENU_PAGE_ID) return

    if (tab?.id === undefined) {
      log.warn('Клик по пункту меню без вкладки — игнорирую')
      return
    }

    if (info.menuItemId === MENU_PAGE_ID) {
      void sendToTab(tab.id, 'ENHANCE_PAGE', {}).then((response) => {
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
    void sendToTab(tab.id, 'CONTEXT_MENU_ENHANCE', { srcUrl: info.srcUrl }, info.frameId ?? 0).then(
      (response) => {
        if (response?.handled) return
        log.warn('Вкладка не обработала выбор из контекстного меню', {
          frameId: info.frameId,
          srcUrl: info.srcUrl,
        })
      },
    )
  })
}
