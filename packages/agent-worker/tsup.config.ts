import { defineConfig } from 'tsup';

/**
 * Two runnable entries: the worker (`dist/index.js`) and the demo seeder (`dist/seed-demo.js`).
 * The workspace packages ship TypeScript sources, so they are bundled, together with the Prisma
 * runtime and `pg` that `@veriwork/database` brings (they are not direct dependencies of this
 * package, so plain `node` could not resolve them from `dist/`). Direct dependencies stay external.
 */
export default defineConfig({
  entry: { index: 'src/index.ts', 'seed-demo': 'src/seed-demo.ts' },
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  clean: true,
  sourcemap: true,
  splitting: true,
  noExternal: [/^@veriwork\//],
  // Optional native binding that `pg` only loads on request.
  external: ['pg-native'],
  // Bundled CommonJS modules (pg) call `require` for Node built-ins.
  banner: {
    js: "import { createRequire as __veriworkCreateRequire } from 'node:module';\nconst require = __veriworkCreateRequire(import.meta.url);",
  },
});
