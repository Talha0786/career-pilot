// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { import: importPlugin },
    rules: {
      // The Clean Architecture dependency rule (M2 design) is already a hard
      // compile error for bare-specifier imports, because pnpm only links a
      // package's own node_modules to what's declared in its package.json —
      // `import {...} from '@careerpilot/infrastructure'` inside domain/src
      // fails to resolve (TS2307) before it ever reaches lint. This rule
      // closes the one gap that leaves open: a *relative* path (`../../../
      // infrastructure/src/...`) reaches across package folders on disk and
      // would otherwise bypass that check entirely.
      'import/no-relative-packages': 'error',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['**/*.test.ts', '**/test/**/*.ts', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
