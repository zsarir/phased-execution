// ESLint for the client and the shared modules — flat config, ESLint 10.
//
// Scope is deliberate: `client/src` (the React app + its Vitest suite) and
// `shared/` (the dependency-free ESM both the client and the node suite
// import). The server is plain Node TypeScript run without a build and is
// covered by its own `node --test` suite; it is not linted here.
//
// typescript-eslint parses through the TypeScript *JS* compiler API, which is
// why `package.json` pins `typescript` to the 6.x line (the native 7.x package
// ships `tsc` only). Type-aware rules are off on purpose: the suite runs in
// seconds and a type-checked lint over 150 files would not, and `tsc` already
// runs in CI (`typecheck:client`).
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'client/dist/**',
      'client/.dist-verify/**',
      'client/dev-dist/**',
      'node_modules/**',
      // The service worker is a WebWorker program typechecked on its own
      // (tsconfig.sw.json); its globals are not the app's.
      'client/src/sw.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['client/src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.browser, ...globals.es2021 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The two hook rules that hold regardless of compiler: a hook called
      // conditionally is a bug, and an effect that lies about its inputs is
      // the classic stale-closure bug.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // The rest of `eslint-plugin-react-hooks` 7's recommended set are the
      // React Compiler's rules (set-state-in-effect, refs, purity, static-
      // components, incompatible-library, …). The compiler is not enabled in
      // this app, and those rules flag patterns here that are deliberate — a
      // clock that re-reads on activation, a pane that keeps its status in
      // state beside a ref — so they stay off until a phase turns the
      // compiler on and pays for them all at once.
      // `tsc` already enforces unused locals/params; ESLint's own rule with
      // the `_` convention covers the destructure-to-drop pattern it accepts.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Type-only imports are erased by `verbatimModuleSyntax`; asking for
      // them keeps the runtime graph one-directional (vocab → nothing).
      '@typescript-eslint/consistent-type-imports': [
        'error',
        // `disallowTypeAnnotations: false`: `importOriginal<typeof import('@/lib/api')>()`
        // is Vitest's own documented mock idiom, and the annotation is erased anyway.
        { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      // The `{}` object type reads as "any non-null value" — rarely what was meant.
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
      // A `// @ts-expect-error` without a reason is a rule nobody can revisit.
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'no-restricted-syntax': [
        'error',
        // The colour system: a literal colour in a component is invisible in
        // one of the two themes. Tokens only (`var(--status-*)`, `text-done`…).
        {
          selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
          message: 'No literal colours in the client — use a token (`var(--…)`, a `text-*`/`bg-*` utility).',
        },
        // `scrollIntoView` scrolls every ancestor — including the page — and
        // made the run page crawl under SSE renders. Move `scrollLeft`/`Top`.
        {
          selector: "CallExpression[callee.property.name='scrollIntoView']",
          message:
            'scrollIntoView scrolls every ancestor; move scrollLeft/scrollTop on the one scroller instead.',
        },
      ],
    },
  },
  {
    // The one file where literal colours are CORRECT: the sixteen ANSI slots
    // of the terminal palette are an addressing scheme, not a design decision
    // (its own header says why). Everything that IS a design decision there is
    // still read from the live stylesheet.
    files: ['client/src/views/terminal/palette.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // The Vitest suite: globals on, and a test may name a thing a rule bans.
    files: ['client/src/**/*.test.{ts,tsx}', 'client/src/test/**/*.ts', 'client/src/test-setup.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.vitest } },
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The shared modules and the build scripts: plain ESM for node AND the browser.
    files: ['shared/**/*.{js,mjs}', 'scripts/**/*.mjs', 'vite.config.ts', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { 'no-console': 'off' },
  },
);
