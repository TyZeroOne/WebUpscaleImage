import { detectCapabilities, recommendLevel } from '@/core/device'
import type { QualityLevel } from '@/core/enhance'
import { createLogger } from '@/core/log'
import { getSettings } from '@/core/settings'

/**
 * Превращение пользовательского выбора в конкретный уровень качества.
 *
 * Отдельный модуль, потому что участников трое: настройка пользователя,
 * возможности железа и правило «авто». Смешивать это с логикой обработки
 * значило бы делать её непроверяемой.
 */

const log = createLogger('quality')

let announced = false

/**
 * Действующий уровень.
 *
 * Если пользователь выбрал конкретный — берётся он, без оглядки на железо.
 * Это принципиально: пользователь имеет право попросить «качественно»
 * на слабой машине и подождать. Автоматика понижает уровень только тогда,
 * когда её об этом просят выбором «авто».
 */
export async function resolveQualityLevel(): Promise<QualityLevel> {
  const settings = await getSettings()
  if (settings.quality !== 'auto') return settings.quality

  const capabilities = await detectCapabilities()
  const level = recommendLevel(capabilities)

  // Один раз за страницу: иначе режим «вся страница» писал бы это полсотни раз.
  if (!announced) {
    announced = true
    log.info(
      `Уровень «авто» разрешён в «${level}» ` +
        `(WebGPU: ${capabilities.webgpu ? 'да' : 'нет'}, ` +
        `SIMD: ${capabilities.wasmSimd ? 'да' : 'нет'}, ` +
        `ядер: ${capabilities.logicalCores})`,
    )
  }
  return level
}
