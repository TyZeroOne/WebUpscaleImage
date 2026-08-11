import { createEnhancer } from '@/core/enhance'
import type { EnhanceOptions, EnhanceResult } from '@/core/enhance'
import { createLogger } from '@/core/log'
import { type EnhancePool, createEnhancePool } from './worker-pool'

/**
 * Единая точка запуска вычислений: в воркере, а при невозможности — на месте.
 *
 * Здесь же живёт правило владения ImageBitmap: функция ЗАБИРАЕТ картинку себе
 * и обязана её освободить в любом исходе. Это не стилистика — при передаче
 * в воркер картинка отсоединяется от текущего потока, и вызывающий код
 * физически не может ею распорядиться.
 */

const log = createLogger('runner')

/**
 * undefined — пул ещё не пробовали создать, null — попытка была и не удалась.
 * Различать важно: повторять неудачную попытку на каждой картинке бессмысленно
 * (причина — политика безопасности страницы, она не изменится).
 */
let pool: EnhancePool | null | undefined

export function isWorkerModeActive(): boolean {
  return pool != null
}

/** Сколько задач имеет смысл выполнять одновременно в текущем режиме. */
export function resolveConcurrency(): number {
  if (pool === undefined) pool = createEnhancePool()
  /**
   * Без воркеров параллелизм строго 1: вычисления синхронные и в единственном
   * потоке, две задачи «одновременно» лишь удвоили бы пик памяти, не сократив
   * общее время ни на миллисекунду.
   */
  return pool ? pool.size : 1
}

export async function runEnhance(
  input: { bitmap: ImageBitmap; sourceUrl: string },
  options: EnhanceOptions,
  signal?: AbortSignal,
): Promise<EnhanceResult> {
  if (pool === undefined) {
    pool = createEnhancePool()
    log.info(pool ? `Вычисления в воркерах, размер пула: ${pool.size}` : 'Воркеры недоступны, считаю в потоке страницы')
  }

  if (pool) {
    /**
     * Отката на вычисления в потоке страницы здесь НЕТ, и это осознанно.
     * Картинка уже передана воркеру вместе с владением: в этом потоке
     * она отсоединена, и повторить работу не на чем. Откат возможен только
     * до отправки — то есть на уровне «пул вообще не создался».
     */
    return pool.run(input, options, signal)
  }

  try {
    return await createEnhancer(options.level).enhance(input, options, signal)
  } finally {
    input.bitmap.close()
  }
}
