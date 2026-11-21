// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const TS_APP = ['src/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts'];
const TS_FUNCTIONS = ['functions/**/*.ts'];
const TS_TYPED = [...TS_APP, ...TS_FUNCTIONS];

export default defineConfig(
  {
    // 对应 .prettierignore：构建产物、依赖、生成文件
    ignores: ['dist/', 'node_modules/', '.wrangler/', 'scripts/out/', 'coverage/', 'art/gallery.html', 'docs/guide/数据/', 'public/'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── 类型感知规则：src / scripts / tests 用根 tsconfig，functions 用 functions/tsconfig.json ──
  {
    files: TS_APP,
    languageOptions: { parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname } },
  },
  {
    files: TS_FUNCTIONS,
    languageOptions: { parserOptions: { project: './functions/tsconfig.json', tsconfigRootDir: import.meta.dirname } },
  },
  {
    files: TS_TYPED,
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
    },
  },

  // ── 通用规则 ──
  {
    files: ['**/*.{ts,js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    plugins: { 'simple-import-sort': simpleImportSort },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        // 允许 import('x').T 形式的类型注解（少量用于避免循环依赖 / 单处引用）
        { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // ── 确定性：src/core 只能用种子随机数（core/rng.ts）与模拟时间（帧计数 / world.time） ──
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'src/core 必须确定性：用 core/rng.ts 的种子随机数。' },
        { object: 'Date', property: 'now', message: 'src/core 必须确定性：用模拟时间（world 的帧 / 秒），不要读系统时钟。' },
        { object: 'performance', property: 'now', message: 'src/core 必须确定性：用模拟时间，不要读系统时钟。' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'src/core 必须确定性：不要读系统时钟。' },
      ],
    },
  },

  // ── Node 环境：脚本、测试、Pages Functions、构建配置 ──
  {
    files: ['scripts/**/*.{ts,mjs}', 'tests/**/*.ts', 'vite.config.ts', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['scripts/**/*.{ts,mjs}'],
    rules: { 'no-console': 'off' },
  },
  {
    files: TS_FUNCTIONS,
    languageOptions: { globals: { ...globals.serviceworker } },
  },

  // 未纳入任何 tsconfig 的 JS 文件：关闭类型感知规则
  {
    files: ['**/*.{js,mjs}'],
    ...tseslint.configs.disableTypeChecked,
  },

  // 必须放最后：关闭与 Prettier 冲突的格式类规则
  prettier,
);
