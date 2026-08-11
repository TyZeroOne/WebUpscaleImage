import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * Отдельная сборка content script.
 *
 * Почему отдельная: Chrome исполняет файлы из manifest.content_scripts[].js
 * как КЛАССИЧЕСКИЕ скрипты. `import`/`export` в них — синтаксическая ошибка,
 * а code splitting невозможен в принципе: браузер загрузит ровно один файл
 * и не пойдёт за чанками.
 *
 * Поэтому формат — iife, а весь граф зависимостей (включая динамические
 * импорты) схлопывается в один self-contained файл dist/content.js.
 */
export default defineConfig(({ mode }) => {
  const isDev = mode === 'development'

  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    // public/ уже скопирован основной сборкой — повторять не нужно.
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
      sourcemap: isDev ? 'inline' : false,
      // Один CSS-файл на весь content script вместо нескольких чанков.
      cssCodeSplit: false,
      rollupOptions: {
        input: {
          content: 'src/content/index.ts',
        },
        output: {
          // Rolldown (бандлер Vite 8) для формата iife сам выключает
          // code splitting и инлайнит динамические импорты, поэтому явный
          // inlineDynamicImports здесь не нужен — он только выдаёт warning
          // «ignored because codeSplitting: false is set».
          format: 'iife',
          entryFileNames: 'content.js',
          assetFileNames: '[name][extname]',
        },
      },
    },
  }
})
