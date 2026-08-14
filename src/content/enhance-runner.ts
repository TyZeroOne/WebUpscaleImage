import { NothingToDoError, createEnhancer, isMlAllowed, resolvePlan } from '@/core/enhance'
import type { EnhanceOperation, EnhanceOptions, EnhanceResult } from '@/core/enhance'
import { createLogger } from '@/core/log'
import type { ModelChoice } from '@/core/settings'
import {
  type MlRuntime,
  getMlRuntime,
  isMlApplicable,
  modelSynthesizesDetail,
} from './ml-client'
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

/**
 * Классический апскейл: в воркере, а при их недоступности — в потоке страницы.
 *
 * Вынесено отдельной функцией, потому что вызывается из двух мест: как основной
 * путь и как второй проход поверх результата модели.
 */
async function runClassic(
  input: { bitmap: ImageBitmap; sourceUrl: string },
  options: EnhanceOptions,
  signal?: AbortSignal,
): Promise<EnhanceResult> {
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

/**
 * Отклонение размера, которое не стоит отдельного прохода.
 * Пять процентов — запас на округления.
 */
const SCALE_TOLERANCE = 0.05

/**
 * Приведение результата модели к запрошенному размеру.
 *
 * МОДЕЛЬ ЗАПУСКАЕТСЯ СТОЛЬКО РАЗ, СКОЛЬКО ПОМЕЩАЕТСЯ.
 *
 * Раньше здесь был один проход модели плюс Ланцош на всё остальное.
 * Для двукратной модели при запросе в четыре раза это означало, что половину
 * работы делает фильтр — то есть просто размывает то, что модель восстановила.
 * Повторный прогон модели по её же результату даёт заметно больше деталей:
 * на втором проходе она работает с уже восстановленной картинкой, а не
 * с исходной мелкой.
 *
 * Остаток после целого числа проходов доводится Ланцошем — в любую сторону.
 * Уменьшение здесь не потеря, а передискретизация с запасом: модель посчитала
 * больше пикселей, чем нужно, и усреднение их даёт результат чище, чем
 * попадание точно в цель.
 */
async function runMlPipeline(
  input: { bitmap: ImageBitmap; sourceUrl: string },
  options: EnhanceOptions,
  ml: MlRuntime,
  signal?: AbortSignal,
): Promise<EnhanceResult> {
  /**
   * Число проходов планируется ЗАРАНЕЕ, до первого запуска.
   *
   * Иначе не узнать, какой проход последний, а это важно: нерезкое
   * маскирование должно примениться ровно один раз, к готовому результату.
   * Применённое на каждом проходе, оно наложилось бы само на себя и дало бы
   * грубые ореолы вокруг всех краёв.
   *
   * Планировать можно точно: размер результата каждого прохода известен
   * заранее, он равен размеру входа, умноженному на коэффициент модели.
   */
  let passes = 0
  let achieved = 1
  let width = input.bitmap.width
  let height = input.bitmap.height
  while (
    options.scale / achieved >= ml.scale - SCALE_TOLERANCE &&
    width * height <= ml.maxInputPixels
  ) {
    passes += 1
    achieved *= ml.scale
    width *= ml.scale
    height *= ml.scale
  }
  // Применимость модели уже проверена вызывающей стороной, поэтому хотя бы
  // один проход делается всегда — даже если он даст больше, чем просили.
  passes = Math.max(1, passes)
  achieved = ml.scale ** passes

  const remaining = options.scale / achieved
  const needsFinalResize = Math.abs(remaining - 1) > SCALE_TOLERANCE

  let current: EnhanceResult | null = null
  let bitmap = input.bitmap
  let totalMs = 0

  for (let pass = 0; pass < passes; pass++) {
    // Резкость поднимает последний шаг пайплайна. Если после проходов
    // модели будет ещё изменение размера, поднимать её здесь рано:
    // масштабирование всё равно сгладит края.
    const isLastStep = pass === passes - 1 && !needsFinalResize
    if (pass > 0) log.debug(`Дополнительный проход модели: ${pass}/${passes - 1}`)
    current = await ml.run(bitmap, input.sourceUrl, isLastStep ? options.sharpen : 0)
    totalMs += current.durationMs
    if (pass < passes - 1) bitmap = await createImageBitmap(current.blob)
  }

  const result = current as EnhanceResult
  if (!needsFinalResize) return { ...result, durationMs: totalMs }

  const finalBitmap = await createImageBitmap(result.blob)
  const finished = await runClassic(
    { bitmap: finalBitmap, sourceUrl: input.sourceUrl },
    { ...options, scale: remaining },
    signal,
  )

  return {
    ...finished,
    /**
     * Бэкендом считается модель: именно она определила качество результата,
     * а последний проход только привёл размер к запрошенному.
     */
    backend: result.backend,
    durationMs: totalMs + finished.durationMs,
  }
}

/**
 * Смешивание результата модели с результатом обычного фильтра.
 *
 * ЗАЧЕМ ЭТО НУЖНО
 *
 * GAN-модель обучена на чистых уменьшенных копиях фотографий. Реальная
 * картинка из интернета сжата, и сеть принимает блоки JPEG за текстуру:
 * достраивает по ним детали, которых нет. Получаются характерные волнистые
 * «червяки» вдоль краёв и на однородных поверхностях.
 *
 * Полностью убрать их можно только другой моделью (обученной на реальных
 * искажениях), а из доступного — ослабить, смешав с результатом фильтра,
 * который ничего не выдумывает. Приём стандартный: тем же способом
 * регулируют силу эффекта в настольных апскейлерах.
 *
 * Смешивание идёт через canvas двумя вызовами drawImage, а не попиксельно:
 * композитинг выполняет браузер, обычно на видеокарте, и стоит миллисекунды
 * даже на 4К.
 */
async function blendResults(
  enhanced: EnhanceResult,
  plain: EnhanceResult,
  strength: number,
): Promise<EnhanceResult> {
  const [top, bottom] = await Promise.all([
    createImageBitmap(enhanced.blob),
    createImageBitmap(plain.blob),
  ])
  try {
    const canvas = new OffscreenCanvas(enhanced.width, enhanced.height)
    const context = canvas.getContext('2d')
    if (!context) return enhanced

    /**
     * Внизу — результат фильтра, сверху с прозрачностью — результат сети.
     * Размеры обычно совпадают; если нет, drawImage растянет нижний слой,
     * что дешевле и безопаснее, чем отказываться от смешивания.
     */
    context.drawImage(bottom, 0, 0, enhanced.width, enhanced.height)
    context.globalAlpha = strength / 100
    /**
     * source-atop, а не обычное наложение: этот режим оставляет альфу
     * нижнего слоя нетронутой и подмешивает верхний только туда, где низ
     * непрозрачен.
     *
     * Без него у полупрозрачных пикселей альфа росла бы: обычное наложение
     * складывает прозрачности, и при альфе 0.5 в обоих слоях и силе 70%
     * получилось бы 0.68 вместо 0.5 — картинка становилась бы плотнее там,
     * где должна просвечивать.
     */
    context.globalCompositeOperation = 'source-atop'
    context.drawImage(top, 0, 0, enhanced.width, enhanced.height)
    context.globalCompositeOperation = 'source-over'
    context.globalAlpha = 1

    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return { ...enhanced, blob, durationMs: enhanced.durationMs + plain.durationMs }
  } finally {
    top.close()
    bottom.close()
  }
}

/**
 * Улучшение качества без изменения размера.
 *
 * ПОЧЕМУ ЭТО НЕ «ТО ЖЕ САМОЕ С КОЭФФИЦИЕНТОМ 1»
 *
 * При коэффициенте 1 обычный путь не сделал бы ничего осмысленного: модель
 * увеличивает на фиксированное число по своей архитектуре, а интерполяция
 * в тот же самый размер — тождественное преобразование.
 *
 * Работающий приём — СУПЕРСЭМПЛИНГ: прогнать картинку через модель
 * с увеличением, а затем вернуть исходный размер уменьшением.
 *
 *     оригинал → [модель ×N] → [уменьшение ÷N] → оригинальный размер
 *
 * Выигрыш здесь не от размера, а от того, что происходит при уменьшении.
 * Модель восстанавливает детали на увеличенной сетке; уменьшение усредняет
 * каждые N×N пикселей в один. Усреднение сохраняет то, в чём модель была
 * уверена (края, текстура остаются согласованными между соседними пикселями),
 * и гасит то, в чём она ошиблась: выдуманная микротекстура несогласованна
 * и при усреднении взаимно уничтожается.
 *
 * Побочный и очень полезный эффект: те самые волнистые артефакты, которые
 * GAN даёт на сжатых фотографиях, при уменьшении подавляются сильнее всего —
 * они мелкие и хаотичные. То есть здесь тяжёлая модель безопаснее, чем
 * при обычном увеличении.
 *
 * Если модель недоступна, остаётся только нерезкое маскирование. Это честно
 * меньше, но всё же не ничего.
 */
async function runRefine(
  input: { bitmap: ImageBitmap; sourceUrl: string },
  options: EnhanceOptions,
  model: ModelChoice,
  strength: number,
  signal?: AbortSignal,
): Promise<EnhanceResult> {
  const plan = resolvePlan(options.level)

  /**
   * Первое условие — свойство модели, и проверяется оно ДО её загрузки.
   *
   * Круговой рейс через модель, которая сглаживает, ХУЖЕ, чем ничего: замер
   * дал резкость 46.6 против 56.0 у оригинала и 71.8 у одного лишь
   * маскирования. Модель, минимизирующая ошибку, не добавляет того, что
   * переживёт уменьшение. Числа целиком — в комментарии к synthesizesDetail
   * в ml-client.ts.
   *
   * Порядок здесь не косметика: getMlRuntime поднимает воркер и грузит веса,
   * и спрашивать свойство у него означало бы платить 380 мс за ответ
   * «модель не подходит», который известен заранее.
   */
  const worthTrying = plan.useMl && modelSynthesizesDetail(model) && !signal?.aborted
  const ml = worthTrying ? await getMlRuntime(model) : null

  /**
   * Применимость проверяется по КОЭФФИЦИЕНТУ МОДЕЛИ, а не по запрошенному.
   * Запрошена единица, но модель мы собираемся запускать по-настоящему,
   * с её собственным увеличением.
   */
  const usable =
    ml !== null &&
    isMlAllowed(options.level, ml.backend) &&
    isMlApplicable(ml, input.bitmap.width, input.bitmap.height, ml.scale)

  if (!usable || !ml) {
    /**
     * Без подходящей модели остаётся нерезкое маскирование. Это честно
     * меньше, но измеримо лучше и оригинала, и кругового рейса через
     * сглаживающую модель.
     *
     * А если и резкость выключена, делать нечего вовсе. Сюда попадают
     * случаи, которых планировщик увидеть не мог: модель подходит
     * по свойству, но картинка для неё слишком велика. Без этой проверки
     * расширение подменило бы картинку её же копией и отрапортовало «Готово».
     */
    if (options.sharpen <= 0) {
      input.bitmap.close()
      /**
       * Причины две, и выход из них разный. Если модель отвергнута по своей
       * природе — надо выбрать другую. Если она подходящая, но картинка
       * для неё велика — модель менять как раз не нужно.
       */
      throw new NothingToDoError(worthTrying ? 'refine-too-large' : 'refine-no-op')
    }
    log.debug('Улучшаю качество только маскированием: подходящей модели нет')
    return runClassic(input, { ...options, scale: 1 }, signal)
  }

  const needsBlend = model === 'detailed' && strength < 100
  const plainSource = needsBlend ? await createImageBitmap(input.bitmap) : null

  try {
    // Резкость на этом шаге не поднимаем: впереди уменьшение, оно бы её съело.
    const upscaled = await ml.run(input.bitmap, input.sourceUrl, 0)
    log.debug(`Суперсэмплинг: ×${ml.scale} моделью, затем возврат к исходному размеру`)

    const upBitmap = await createImageBitmap(upscaled.blob)
    const refined = await runClassic(
      { bitmap: upBitmap, sourceUrl: input.sourceUrl },
      { ...options, scale: 1 / ml.scale },
      signal,
    )

    const result: EnhanceResult = {
      ...refined,
      backend: upscaled.backend,
      durationMs: upscaled.durationMs + refined.durationMs,
    }

    if (!plainSource) return result

    /**
     * Для смешивания нужен «обычный» вариант того же размера — то есть сам
     * оригинал, обработанный теми же завершающими шагами. Коэффициент 1,
     * маскирование то же самое.
     */
    const plain = await runClassic(
      { bitmap: plainSource, sourceUrl: input.sourceUrl },
      { ...options, scale: 1 },
      signal,
    )
    log.debug(`Смешиваю результат модели с оригиналом: ${strength}%`)
    return await blendResults(result, plain, strength)
  } catch (error) {
    plainSource?.close()
    throw error
  }
}

export async function runEnhance(
  input: { bitmap: ImageBitmap; sourceUrl: string },
  options: EnhanceOptions,
  model: ModelChoice,
  strength: number,
  operation: EnhanceOperation,
  signal?: AbortSignal,
): Promise<EnhanceResult> {
  if (pool === undefined) {
    pool = createEnhancePool()
    log.info(pool ? `Вычисления в воркерах, размер пула: ${pool.size}` : 'Воркеры недоступны, считаю в потоке страницы')
  }

  if (operation === 'refine') return runRefine(input, options, model, strength, signal)

  /**
   * ML пробуется первым, но только когда он уместен.
   *
   * Условия проверяются ДО передачи картинки: после transfer откатиться
   * уже некуда, потому что владение ушло.
   *  - уровень качества вообще разрешает ML (на «быстро» — нет);
   *  - бэкенд подходит под уровень (на «сбалансированно» ML только
   *    на WebGPU: на WASM он стоил бы секунды и перестал бы быть
   *    компромиссом);
   *  - размер входа в пределах потолка бэкенда;
   *  - увеличение не меньше полутора крат.
   *
   * Модель увеличивает ровно вдвое — это её архитектура, а не параметр.
   * Если запрошено больше, недостающее дотягивается Ланцошем ПОВЕРХ
   * результата модели. Это принципиально лучше, чем Ланцош от оригинала:
   * детали, которых в исходнике не было, к этому моменту уже восстановлены,
   * и второй проход лишь растягивает уже восстановленное.
   *
   * Отмена на ML не распространяется: единственный воркер держит
   * загруженную модель, и terminate() выбросил бы её вместе с секундой
   * повторной загрузки. Для одной картинки, которая считается доли
   * секунды на WebGPU, это плохой размен.
   *
   * Воркер вообще не поднимается, если уровень его не разрешает —
   * иначе на «быстро» мы платили бы 800 КБ загрузки впустую.
   */
  const plan = resolvePlan(options.level)
  if (!signal?.aborted && plan.useMl) {
    const ml = await getMlRuntime(model)
    if (
      ml &&
      isMlAllowed(options.level, ml.backend) &&
      isMlApplicable(ml, input.bitmap.width, input.bitmap.height, options.scale)
    ) {
      /**
       * Копия исходника делается ДО передачи в модель: transfer отсоединяет
       * оригинал, и второго шанса получить пиксели уже не будет.
       * Копия нужна только когда смешивание действительно предстоит.
       */
      const needsBlend = model === 'detailed' && strength < 100
      const plainSource = needsBlend ? await createImageBitmap(input.bitmap) : null

      try {
        const scaled = await runMlPipeline(input, options, ml, signal)
        if (!plainSource) return scaled

        const plain = await runClassic(
          { bitmap: plainSource, sourceUrl: input.sourceUrl },
          options,
          signal,
        )
        log.debug(`Смешиваю результат модели с фильтром: ${strength}%`)
        return await blendResults(scaled, plain, strength)
      } catch (error) {
        plainSource?.close()
        // Картинка уже передана воркеру — откатиться на классику нельзя.
        log.error('ML-обработка не удалась:', error)
        throw error
      }
    }
  }

  return runClassic(input, options, signal)
}
