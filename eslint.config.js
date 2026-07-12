// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/coverage/**', '**/next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { import: importPlugin },
    settings: {
      // Every workspace package uses NodeNext-style explicit ".js" import
      // specifiers that actually resolve to ".ts" source on disk (task 013's
      // webpack.resolve.extensionAlias note applies here too). Without a
      // TypeScript-aware resolver, eslint-plugin-import can't resolve these
      // specifiers at all — and `import/no-relative-packages` silently does
      // NOT report anything for an import it can't resolve, rather than
      // erroring loudly. That gap is exactly what let a real cross-boundary
      // relative import through undetected (found via task 014's own
      // boundary-check test failing on a clean CI runner).
      'import/resolver': { typescript: true },
    },
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
  {
    // Plain Node scripts (scripts/*.mjs) aren't TypeScript, so they don't get
    // typescript-eslint's no-undef override — declare the Node runtime
    // globals explicitly instead of every script tripping `no-undef` on
    // `process`/`console`/`fetch`.
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
);
