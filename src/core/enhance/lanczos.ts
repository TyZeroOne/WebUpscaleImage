/**
 * Ресемплинг изображения фильтром Ланцоша.
 *
 * Модуль намеренно не знает ни про DOM, ни про canvas, ни про chrome API —
 * только ImageData на входе и ImageData на выходе. Это условие того, чтобы
 * на этапе 4 его можно было перенести в Web Worker, не меняя ни строчки.
 *
 * ТЕОРИЯ КОРОТКО
 *
 * Увеличить картинку — значит вычислить цвет в точках, которых в оригинале
 * не было. Любой метод интерполяции отличается только тем, как он смешивает
 * соседние пиксели:
 *
 *   nearest  — берём ближайший. Быстро, результат «лесенкой».
 *   bilinear — среднее четырёх соседей. Быстро, результат мыльный.
 *   bicubic  — кубический многочлен по 16 соседям. Резче билинейной.
 *   Lanczos  — окно функции sinc. Резче bicubic, но даёт «звон» на контрастных
 *              границах (тонкий светлый ореол).
 *
 * Функция sinc(x) = sin(pi*x)/(pi*x) — идеальный фильтр с точки зрения теории
 * сигналов, но он бесконечен: чтобы посчитать один пиксель, нужны все.
 * Ланцош умножает sinc на такое же, но растянутое окно sinc(x/a) и обрезает
 * всё за пределами |x| < a. Параметр a — сколько соседей учитывать с каждой
 * стороны: a=2 берёт 4 пикселя по оси, a=3 — 6.
 */

/** Ядро Ланцоша. a — радиус окна. */
function lanczosKernel(x: number, a: number): number {
  if (x === 0) return 1
  const ax = Math.abs(x)
  if (ax >= a) return 0
  const pix = Math.PI * x
  return (a * Math.sin(pix) * Math.sin(pix / a)) / (pix * pix)
}

interface AxisWeights {
  /** Индекс первого исходного пикселя, участвующего в вычислении. */
  starts: Int32Array
  /** Сколько соседей участвует. Одинаково для всех выходных пикселей. */
  taps: number
  /** Веса, разложенные подряд: taps штук на каждый выходной пиксель. */
  weights: Float32Array
}

/**
 * Предрасчёт весов для одной оси.
 *
 * Веса зависят только от номера выходного пикселя, а не от содержимого
 * картинки. Значит, их можно посчитать один раз для всей оси, а не для
 * каждого из миллионов пикселей. Для картинки 1920×1080 это разница между
 * четырьмя тысячами вычислений синуса и двадцатью миллионами.
 */
function buildWeights(srcSize: number, dstSize: number, a: number): AxisWeights {
  const scale = dstSize / srcSize

  /**
   * При УМЕНЬШЕНИИ картинки окно фильтра нужно растянуть.
   * Иначе между выходными пикселями остаются неучтённые входные, и картинка
   * покрывается алиасингом (муаром на мелких деталях). При увеличении
   * растягивать не нужно — там входных пикселей и так с избытком.
   */
  const filterScale = scale < 1 ? 1 / scale : 1
  const support = a * filterScale

  const taps = Math.min(srcSize, Math.ceil(support * 2) + 1)
  const starts = new Int32Array(dstSize)
  const weights = new Float32Array(dstSize * taps)

  for (let i = 0; i < dstSize; i++) {
    /**
     * Центр выходного пикселя в координатах исходной картинки.
     *
     * Слагаемые 0.5 — не мелочь: координата пикселя указывает на его левый
     * край, а фильтровать нужно относительно центра. Без этой поправки
     * результат уезжает на полпикселя, и при многократном применении
     * картинка заметно смещается.
     */
    const center = (i + 0.5) / scale - 0.5

    let start = Math.ceil(center - support)
    // Окно не должно вылезать за границы картинки. Вместо «повторить крайний
    // пиксель» окно сдвигается внутрь — так проще и не даёт тёмной каймы.
    if (start < 0) start = 0
    if (start + taps > srcSize) start = Math.max(0, srcSize - taps)
    starts[i] = start

    let sum = 0
    const offset = i * taps
    for (let t = 0; t < taps; t++) {
      const w = lanczosKernel((start + t - center) / filterScale, a)
      weights[offset + t] = w
      sum += w
    }

    /**
     * Нормировка: сумма весов обязана равняться единице.
     *
     * После обрезки окна и сдвига у границ она единице не равна. Если этого
     * не исправить, яркость картинки поплывёт — по краям сильнее, чем
     * в середине, и появится видимая рамка.
     */
    if (sum !== 0) {
      const inv = 1 / sum
      for (let t = 0; t < taps; t++) weights[offset + t]! *= inv
    }
  }

  return { starts, taps, weights }
}

/**
 * Пересэмплирование ImageData в заданный размер.
 *
 * @param a радиус окна: 2 — быстрее и мягче, 3 — резче и вдвое дороже.
 */
export function resampleLanczos(
  src: ImageData,
  dstWidth: number,
  dstHeight: number,
  a: number,
): ImageData {
  const srcWidth = src.width
  const srcHeight = src.height
  const srcData = src.data

  const hx = buildWeights(srcWidth, dstWidth, a)
  const vy = buildWeights(srcHeight, dstHeight, a)

  /**
   * ФИЛЬТРАЦИЯ ИДЁТ В ДВА ПРОХОДА, ПО ОДНОЙ ОСИ ЗА РАЗ.
   *
   * Двумерное ядро Ланцоша разделимо: вес двумерного соседа равен
   * произведению одномерных весов по X и по Y. Значит, вместо (2a)² операций
   * на пиксель можно сделать 2a по горизонтали и 2a по вертикали.
   * При a=3 это 36 умножений против 12 — разница втрое.
   *
   * Промежуточный буфер — единственная крупная аллокация: он хранит картинку
   * уже растянутую по горизонтали, но ещё исходной высоты.
   */
  const tmp = new Float32Array(dstWidth * srcHeight * 4)

  // --- проход 1: по горизонтали, с домножением на альфу --------------------
  for (let y = 0; y < srcHeight; y++) {
    const srcRow = y * srcWidth * 4
    const tmpRow = y * dstWidth * 4

    for (let x = 0; x < dstWidth; x++) {
      const start = hx.starts[x]!
      const wOffset = x * hx.taps
      let r = 0
      let g = 0
      let b = 0
      let alphaSum = 0

      for (let t = 0; t < hx.taps; t++) {
        const w = hx.weights[wOffset + t]!
        if (w === 0) continue
        const p = srcRow + (start + t) * 4
        /**
         * Цвет домножается на альфу (premultiplied alpha) перед смешиванием.
         *
         * Без этого прозрачные пиксели вносят в среднее свой цвет — а он
         * у полностью прозрачных пикселей обычно чёрный. Результат: тёмная
         * кайма по краям всего, что имеет прозрачность. Тот же приём и по
         * той же причине использован в генераторе иконок (этап 0).
         */
        const alpha = srcData[p + 3]! / 255
        const wa = w * alpha
        r += srcData[p]! * wa
        g += srcData[p + 1]! * wa
        b += srcData[p + 2]! * wa
        alphaSum += wa
      }

      const o = tmpRow + x * 4
      tmp[o] = r
      tmp[o + 1] = g
      tmp[o + 2] = b
      tmp[o + 3] = alphaSum
    }
  }

  // --- проход 2: по вертикали, с обратным делением на альфу ----------------
  const out = new ImageData(dstWidth, dstHeight)
  const outData = out.data

  for (let y = 0; y < dstHeight; y++) {
    const start = vy.starts[y]!
    const wOffset = y * vy.taps
    const outRow = y * dstWidth * 4

    for (let x = 0; x < dstWidth; x++) {
      const column = x * 4
      let r = 0
      let g = 0
      let b = 0
      let alphaSum = 0

      for (let t = 0; t < vy.taps; t++) {
        const w = vy.weights[wOffset + t]!
        if (w === 0) continue
        const p = (start + t) * dstWidth * 4 + column
        r += tmp[p]! * w
        g += tmp[p + 1]! * w
        b += tmp[p + 2]! * w
        alphaSum += tmp[p + 3]! * w
      }

      const o = outRow + column
      if (alphaSum <= 0) {
        // Полностью прозрачный пиксель. Делить на альфу нельзя, а цвет
        // всё равно не виден.
        outData[o] = 0
        outData[o + 1] = 0
        outData[o + 2] = 0
        outData[o + 3] = 0
        continue
      }

      const inv = 1 / alphaSum
      /**
       * Присваивание в Uint8ClampedArray само округляет и обрезает в 0..255.
       * Это важно: Ланцош по своей природе даёт выбросы за границы диапазона
       * (тот самый «звон» на контрастных краях), и их нужно обрезать.
       */
      outData[o] = r * inv
      outData[o + 1] = g * inv
      outData[o + 2] = b * inv
      outData[o + 3] = alphaSum * 255
    }
  }

  return out
}
