// Flat ESLint configuration for Approval Service
// Minimal baseline: ES2022 + TypeScript, node environment, no stylistic noise yet.
// Future enhancements: add security/plugin rules (@eslint-community/eslint-plugin-security),
// import sorting, stricter promise handling.

import js from '@eslint/js';
import globals from 'globals';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: false,
        sourceType: 'module'
      },
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint
    },
    rules: {
      // Minimal blocking rules for now; stricter rules (no-explicit-any, ban-ts-comment, etc.) deferred.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'prefer-const': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
      'no-empty': 'warn'
    }
  },
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'scripts/**',
      '*.config.js'
    ]
  }
];
