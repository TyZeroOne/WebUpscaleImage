import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * Третья сборка: ML-воркер отдельным самостоятельным файлом.
 *
 * Почему отдельно, а не через ?worker&inline, как воркер классического
 * апскейла (этап 4): вместе с TensorFlow.js и двумя бэкендами это мегабайты
 * кода. Встроенный в content.js, он попадал бы в КАЖДУЮ открытую страницу —
 * неприемлемо для расширения, которое большую часть времени ничего не делает.
 *
 * Отдельный файл загружается лениво: только когда пользователь впервые
 * попросил ML-обработку. Загружает его content script (файл объявлен
 * в web_accessible_resources), после чего создаёт из него blob-воркер —
 * тем же приёмом, что и на этапе 4, потому что ограничение остаётся тем же:
 * content script не может создать воркер напрямую из файла расширения.
 */
export default defineConfig(({ mode }) => {
  const isDev = mode === 'development'

  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    publicDir: false,

    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },

    build: {
      outDir: 'dist',
      emptyOutDir: false,
      target: 'chrome116',
      minify: !isDev,
      // Sourcemap выключен даже в dev: карта для TensorFlow.js весит десятки
      // мегабайт и делает пересборку в watch-режиме мучительно долгой,
      // а отлаживать мы будем свой код, а не библиотеку.
      sourcemap: false,
      rollupOptions: {
        input: {
          'ml-worker': 'src/workers/ml.worker.ts',
        },
        output: {
          // Классический скрипт: воркер создаётся из blob-URL, а не как модуль.
          format: 'iife',
          entryFileNames: 'ml-worker.js',
        },
      },
    },
  }
})
