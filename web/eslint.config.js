// Flat ESLint configuration for NanoCOS Web Console (TypeScript + React 18)
export default [
  {
    ignores: ['dist/**', 'node_modules/**', '../internal/web/dist/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-debugger': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
];
