import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  {
    // Scope the boundary to plugin CODE (plugins/<id>/**), not the top-level
    // registry `plugins/index.ts`. The registry is Core-authored glue whose whole
    // job is to import each plugin's entrypoint (e.g. ./sample/server/index); it is
    // not plugin code and must not be subject to the "SDK-only" restriction. Keeping
    // the strong `**/server/**` globs (they match a relative escape like
    // ../../server/storage anywhere in the specifier) preserves the boundary for
    // real plugin files while letting the registry wire plugins up.
    files: ['plugins/*/**/*.ts'],
    // Exempt plugin TEST files: a plugin's test legitimately imports its own
    // entrypoint by relative path (e.g. ../server/index), whose specifier contains
    // "server/" and would otherwise trip the Core-`server/` denylist below. Tests
    // never run in the production server, so this does not affect runtime isolation.
    // (no-restricted-imports matches the specifier string, not the resolved path, so
    // it can't tell a plugin's own ./server subdir from Core's /server — a stricter,
    // resolve-aware boundary is deferred to the boundary-probe hardening task.)
    ignores: ['plugins/*/**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/server/**', '**/shared/**', '**/client/**', '@/*', '@shared/*'],
          message: 'Plugins may import only @vox/plugin-sdk, not Core internals.',
        }],
      }],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '*.config.js', '*.config.ts'],
  }
);
