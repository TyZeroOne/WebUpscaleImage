/**
 * Определение возможностей устройства.
 *
 * На этапе 0 здесь была только синхронная проверка наличия API. Этого
 * достаточно, чтобы что-то показать в popup, но недостаточно, чтобы решать,
 * запускать ли ML: наличие объекта navigator.gpu НЕ означает, что WebGPU
 * работает. Адаптер может не выдаться — драйвер в чёрном списке, видеокарта
 * отключена, запущено в виртуальной машине. Узнать это можно только попыткой.
 */

export interface DeviceCapabilities {
  /** Адаптер WebGPU реально получен, а не просто объявлен API. */
  webgpu: boolean
  /** Что за адаптер, если удалось узнать. Для диагностики в баг-репортах. */
  webgpuAdapter: string | null
  /** WebAssembly с расширением SIMD — от него зависит скорость запасного пути. */
  wasmSimd: boolean
  offscreenCanvas: boolean
  imageBitmap: boolean
  /** Логических ядер. Отсюда берётся размер пула воркеров. */
  logicalCores: number
  /** Приблизительный объём ОЗУ в ГБ. Chrome округляет и режет сверху до 8. */
  memoryGb: number | null
}

/**
 * Минимальный модуль WebAssembly, использующий инструкцию SIMD (v128.const).
 *
 * Стандартный приём проверки: если движок не поддерживает SIMD, модуль
 * не пройдёт валидацию. Это дешевле и надёжнее, чем разбирать строку
 * user-agent или версию браузера.
 */
const WASM_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253,
  15, 253, 98, 11,
])

function detectWasmSimd(): boolean {
  try {
    return WebAssembly.validate(WASM_SIMD_PROBE)
  } catch {
    return false
  }
}

async function detectWebgpu(): Promise<{ available: boolean; adapter: string | null }> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
  if (!gpu) return { available: false, adapter: null }
  try {
    const adapter = await gpu.requestAdapter()
    if (!adapter) return { available: false, adapter: null }
    /**
     * requestAdapterInfo есть не во всех версиях Chrome, а с недавних пор
     * данные отдаются урезанными из соображений приватности (снижение
     * уникальности отпечатка браузера). Поэтому имя адаптера — приятное
     * дополнение для диагностики, а не то, на чём строятся решения.
     */
    const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info
    const label = info ? [info.vendor, info.architecture].filter(Boolean).join(' ') : ''
    return { available: true, adapter: label || 'неизвестный' }
  } catch {
    return { available: false, adapter: null }
  }
}

let cached: Promise<DeviceCapabilities> | null = null

/**
 * Результат кешируется: запрос адаптера WebGPU стоит миллисекунды и не может
 * измениться за время жизни страницы, а спрашивают его и popup, и логика
 * выбора реализации.
 */
export function detectCapabilities(): Promise<DeviceCapabilities> {
  cached ??= (async (): Promise<DeviceCapabilities> => {
    const webgpu = await detectWebgpu()
    return {
      webgpu: webgpu.available,
      webgpuAdapter: webgpu.adapter,
      wasmSimd: detectWasmSimd(),
      offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
      imageBitmap: typeof createImageBitmap === 'function',
      logicalCores: navigator.hardwareConcurrency || 1,
      memoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    }
  })()
  return cached
}
