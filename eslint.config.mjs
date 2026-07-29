// @ts-check
import tseslint from 'typescript-eslint';

/**
 * 技术规划方案 1.1 / 1.2：分层依赖只能自上而下，domain 必须保持纯函数。
 * 这里用 no-restricted-imports 的路径模式做静态强制（不引入额外插件，遵守零依赖倾向）。
 */
const layerRule = (message, patterns) => ({
  'no-restricted-imports': ['error', { patterns: patterns.map((group) => ({ ...group, message })) }],
});

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },

  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'off',
    },
  },

  // ── L2 domain：纯函数边界（红线一） ────────────────────────────────
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'chrome', message: 'domain/ 必须保持纯函数：不得访问 chrome API' },
        { name: 'fetch', message: 'domain/ 必须保持纯函数：不得发起 I/O' },
        { name: 'crypto', message: 'domain/ 必须保持纯函数：哈希函数由调用方注入' },
        { name: 'localStorage', message: 'domain/ 不得访问存储' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'domain/ 不得读取时间：由调用方注入' },
        { object: 'Math', property: 'random', message: 'domain/ 不得取随机数：由调用方注入' },
        { object: 'crypto', property: 'randomUUID', message: 'domain/ 不得取随机数：由调用方注入' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'domain/ 不得读取当前时间：时间戳由调用方注入',
        },
      ],
      ...layerRule('domain/ 只能依赖 domain/ 与 shared/（不含 storage、logger）', [
        { group: ['**/platform/**', '**/remote/**', '**/engine/**', '**/scheduler/**', '**/ui/**'] },
        { group: ['**/shared/logger*', '**/shared/config*'] },
      ]),
    },
  },

  // ── L1 platform ──────────────────────────────────────────────────
  {
    files: ['src/platform/**/*.ts'],
    rules: layerRule('platform/ 只能依赖 shared/ 与 domain/ 的类型', [
      { group: ['**/remote/**', '**/engine/**', '**/scheduler/**', '**/ui/**'] },
    ]),
  },

  // ── L2 remote ────────────────────────────────────────────────────
  {
    files: ['src/remote/**/*.ts'],
    rules: layerRule('remote/ 不得依赖 engine/、scheduler/ 或 ui/', [
      { group: ['**/engine/**', '**/scheduler/**', '**/ui/**'] },
    ]),
  },

  // ── L4 ui：只渲染与收发消息 ────────────────────────────────────────
  {
    files: ['src/ui/**/*.ts'],
    ignores: ['src/ui/messages.ts'],
    rules: layerRule('ui/ 不得含同步逻辑：只能经消息协议与 engine 通信', [
      { group: ['**/engine/**', '**/domain/**', '**/remote/**', '**/scheduler/**'] },
      { group: ['**/platform/bookmarks*', '**/platform/http*', '**/platform/keepalive*'] },
    ]),
  },

  {
    files: ['src/ui/**/*.ts', 'scripts/**/*.mjs', 'test/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // logger 的可选控制台镜像是 NFR-9 的显式组成部分。
  {
    files: ['src/shared/logger.ts'],
    rules: { 'no-console': 'off' },
  },

  {
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);
