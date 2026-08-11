import '@/ui/styles/base.css'
import { detectCapabilities } from '@/core/device'
import { createLogger } from '@/core/log'
import { sendToBackground } from '@/core/messaging'

/**
 * Popup — окно, которое открывается по клику на иконку расширения.
 *
 * На этапе 0 он служит проверочной панелью: показывает версию, отвечает ли
 * service worker и что умеет железо. Это самый дешёвый способ убедиться, что
 * сборка, манифест и обмен сообщениями действительно работают.
 *
 * Важно про жизненный цикл: popup — это полноценный документ, который
 * УНИЧТОЖАЕТСЯ при каждом закрытии. Долгие операции здесь запускать нельзя,
 * они прервутся на полуслове. Поэтому очередь обработки на этапе 3 будет
 * жить в service worker'е, а popup — только показывать её состояние.
 */

const log = createLogger('popup')

function setText(id: string, text: string, state?: 'ok' | 'fail'): void {
  const node = document.getElementById(id)
  if (!node) return
  node.textContent = text
  node.className = state ? `ie-${state}` : ''
}

function renderCapabilities(): void {
  const caps = detectCapabilities()
  setText('webgpu', caps.webgpuApiPresent ? 'есть' : 'нет', caps.webgpuApiPresent ? 'ok' : 'fail')
  setText('offscreen', caps.offscreenCanvas ? 'есть' : 'нет', caps.offscreenCanvas ? 'ok' : 'fail')
  setText('bitmap', caps.imageBitmap ? 'есть' : 'нет', caps.imageBitmap ? 'ok' : 'fail')
  setText('cores', String(caps.logicalCores))
  setText('memory', caps.memoryGb === null ? 'неизвестно' : `${caps.memoryGb} ГБ`)
}

async function pingBackground(): Promise<void> {
  const sentAt = performance.now()
  const response = await sendToBackground('PING', { sentAt })

  if (!response) {
    setText('sw', 'не отвечает', 'fail')
    return
  }
  const elapsed = Math.round(performance.now() - response.roundTripStartedAt)
  setText('sw', `отвечает (${elapsed} мс)`, 'ok')
}

setText('version', `v${chrome.runtime.getManifest().version}`)
renderCapabilities()
void pingBackground().catch((error: unknown) => log.error('PING не прошёл:', error))

document.getElementById('open-options')?.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})
