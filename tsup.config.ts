import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/redis.ts', 'src/otel.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  splitting: false,
  clean: true,
  treeshake: true,
  target: 'es2022',
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
